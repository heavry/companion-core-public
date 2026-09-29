import Foundation
import Combine
import AVFoundation

public enum VoiceBubblePhase: String, Equatable { case loading, ready, playing, paused, stopped, failed, expired }

public struct VoiceMessageState: Equatable {
    public let messageID: Int
    public var phase: VoiceBubblePhase
    public var currentTime: TimeInterval
    public var duration: TimeInterval
    public var waveform: [Double]
    public var errorText: String?
    public var assetID: String
}

@MainActor
public final class VoicePlaybackManager: NSObject, ObservableObject {
    @Published public private(set) var status: VoiceStatus?
    @Published public private(set) var messageStates: [Int: VoiceMessageState] = [:]
    @Published public private(set) var errorText: String?
    public var isPlaying: Bool { messageStates.values.contains { $0.phase == .playing } }
    public var activeMessageID: Int? { messageStates.first(where: { [.playing, .paused].contains($0.value.phase) })?.key }

    private let api: APIClient
    private let loadAudio: (String) async throws -> Data
    private let synthesizeRemote: (RemoteVoicePlan) async throws -> Data
    private let remoteStore: RemoteVoicePlanStore
    /// local-primary: Core owns canonical TTS. Remote local synth is cloud fallback only.
    public let allowsRemoteLocalSynthesis: Bool
    private var audioByMessage: [Int: Data] = [:]
    private var remoteGenerationByMessage: [Int: String] = [:]
    private var remoteInFlight: Set<String> = []
    private var pendingAutoplay: Set<Int> = []
    private var latestUserMessageID: Int = 0
    private var player: AVAudioPlayer?
    private var progressTask: Task<Void, Never>?
    private var generation = UUID()

    public init(api: APIClient) {
        self.api = api
        self.loadAudio = { id in try await api.mediaData(id: id).0 }
        self.remoteStore = RemoteVoicePlanStore()
        self.synthesizeRemote = Self.localVoxCPMSynthesis
        self.allowsRemoteLocalSynthesis = false
        super.init()
    }
    init(api: APIClient, loadAudio: @escaping (String) async throws -> Data) {
        self.api = api; self.loadAudio = loadAudio
        self.remoteStore = RemoteVoicePlanStore()
        self.synthesizeRemote = Self.localVoxCPMSynthesis
        self.allowsRemoteLocalSynthesis = false
        super.init()
    }
    init(api: APIClient, loadAudio: @escaping (String) async throws -> Data,
         synthesizeRemote: @escaping (RemoteVoicePlan) async throws -> Data,
         remoteStore: RemoteVoicePlanStore) {
        self.api = api; self.loadAudio = loadAudio
        self.synthesizeRemote = synthesizeRemote; self.remoteStore = remoteStore
        self.allowsRemoteLocalSynthesis = true
        super.init()
    }

    /// New user turn invalidates old pending autoplay (staleVoiceAutoplay = 0).
    public func noteUserTurn(messageID: Int? = nil) {
        if let messageID { latestUserMessageID = max(latestUserMessageID, messageID) }
        else { latestUserMessageID += 1 }
        pendingAutoplay.removeAll()
    }

    public func isMessageFresh(_ messageID: Int) -> Bool {
        messageID > latestUserMessageID
    }

    public func handleVoiceReady(_ payload: VoiceReadyPayload) {
        guard let asset = payload.voiceAsset else { return }
        let messageID = payload.messageID
        let pseudo = VoiceAsset(voiceAssetID: asset.voiceAssetID, duration: asset.duration, state: asset.state, url: asset.url)
        Task {
            await prepare(messageID: messageID, asset: pseudo, transcript: "")
            // Asset ready ≠ autoplay. Never play a stale voice.
            guard payload.shouldAutoplay, isMessageFresh(messageID) else {
                pendingAutoplay.remove(messageID)
                return
            }
            startPlayback(messageID: messageID)
            pendingAutoplay.remove(messageID)
        }
    }

    public func scheduleAutoplay(messageID: Int) {
        guard isMessageFresh(messageID) else { return }
        pendingAutoplay.insert(messageID)
    }

    public func refresh() async { do { status = try await api.voiceStatus(); errorText = nil } catch { errorText = "无法读取本地语音状态" } }
    public func update(enabled: Bool, mode: String, speed: Double) async {
        do { status = try await api.updateVoiceSettings(enabled: enabled, mode: mode, speed: speed); errorText = nil }
        catch { errorText = "本地语音设置未能保存" }
    }
    public func state(for messageID: Int) -> VoiceMessageState? { messageStates[messageID] }

    public func prepare(rows: [ConversationMessagesResponse.Row], autoPlayRemotePlans: Bool = false) async {
        // Both user and assistant voice bubbles must load; otherwise UI sticks at .loading forever.
        for row in rows where row.voiceAsset != nil {
            guard let asset = row.voiceAsset else { continue }
            await prepare(messageID: row.id, asset: asset, transcript: row.contentText ?? "")
        }
        for row in rows where row.voicePlan != nil {
            guard let plan = row.voicePlan else { continue }
            // Core voice_asset is canonical. Never double-synthesize when asset exists.
            if row.voiceAsset != nil { continue }
            guard allowsRemoteLocalSynthesis else {
                // Wait for Core voice-ready / durable asset (local-primary async).
                messageStates[row.id] = VoiceMessageState(
                    messageID: row.id, phase: .loading, currentTime: 0, duration: 0,
                    waveform: Self.waveform(for: plan.text), errorText: nil,
                    assetID: "pending:\(plan.generationID)"
                )
                if autoPlayRemotePlans, isMessageFresh(row.id) { scheduleAutoplay(messageID: row.id) }
                continue
            }
            await prepareRemote(messageID: row.id, plan: plan, autoPlay: autoPlayRemotePlans && isMessageFresh(row.id))
        }
    }

    private func prepareRemote(messageID: Int, plan: RemoteVoicePlan, autoPlay: Bool) async {
        guard plan.voiceRequested, !plan.generationID.isEmpty else { return }
        let pseudoAsset = VoiceAsset(voiceAssetID: "local:\(plan.generationID)", duration: 0, state: "ready")
        remoteGenerationByMessage[messageID] = plan.generationID
        if let cached = remoteStore.audio(for: plan.generationID) {
            audioByMessage[messageID] = cached
            messageStates[messageID] = Self.state(messageID, asset: pseudoAsset, transcript: plan.text, phase: .ready)
            if autoPlay, isMessageFresh(messageID), remoteStore.entry(for: plan.generationID)?.played != true {
                startPlayback(messageID: messageID)
                remoteStore.markPlayed(plan.generationID)
            }
            return
        }
        guard !remoteInFlight.contains(plan.generationID) else { return }
        remoteInFlight.insert(plan.generationID)
        messageStates[messageID] = Self.state(messageID, asset: pseudoAsset, transcript: plan.text, phase: .loading)
        defer { remoteInFlight.remove(plan.generationID) }
        do {
            let data = try await synthesizeRemote(plan)
            guard data.count >= 4, String(data: data.prefix(4), encoding: .ascii) == "RIFF" else {
                throw APIError.decoding("local VoxCPMANE returned non-WAV data")
            }
            try remoteStore.saveAudio(data, generationID: plan.generationID)
            audioByMessage[messageID] = data
            messageStates[messageID] = Self.state(messageID, asset: pseudoAsset, transcript: plan.text, phase: .ready)
            if autoPlay, isMessageFresh(messageID) {
                startPlayback(messageID: messageID)
                remoteStore.markPlayed(plan.generationID)
            }
        } catch {
            // Text is already durable and visible. Local TTS failure is a
            // presentation fallback only and must never retry the chat turn.
            messageStates[messageID] = Self.state(messageID, asset: pseudoAsset, transcript: plan.text,
                                                  phase: .failed, error: "本地语音不可用，已显示文字")
        }
    }

    private static func localVoxCPMSynthesis(_ plan: RemoteVoicePlan) async throws -> Data {
        var request = URLRequest(url: URL(string: "http://127.0.0.1:7862/v1/audio/speech")!)
        request.httpMethod = "POST"
        request.timeoutInterval = 60
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: [
            "model": "voxcpm2", "input": plan.text, "voice": plan.voiceProfile,
            "voice_mode": "reference", "response_format": "wav",
            "inference_timesteps": 10, "cfg_value": 2.0
        ])
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            throw APIError.http((response as? HTTPURLResponse)?.statusCode ?? -1, "local VoxCPMANE unavailable")
        }
        return data
    }

    public func prepare(messageID: Int, asset: VoiceAsset, transcript: String) async {
        if asset.state == "expired" {
            audioByMessage[messageID] = nil
            messageStates[messageID] = Self.state(messageID, asset: asset, transcript: transcript, phase: .expired, error: "语音已过期")
            return
        }
        if audioByMessage[messageID] != nil, messageStates[messageID]?.assetID == asset.voiceAssetID { return }
        if messageStates[messageID]?.phase == .loading, messageStates[messageID]?.assetID == asset.voiceAssetID { return }
        messageStates[messageID] = Self.state(messageID, asset: asset, transcript: transcript, phase: .loading)
        do {
            let data = try await loadAudio(asset.voiceAssetID)
            guard !Task.isCancelled else { return }
            let audio = try AVAudioPlayer(data: data)
            audioByMessage[messageID] = data
            var ready = Self.state(messageID, asset: asset, transcript: transcript, phase: .ready)
            ready.duration = asset.duration > 0 ? asset.duration : audio.duration
            messageStates[messageID] = ready
        } catch {
            guard !Task.isCancelled else { return }
            messageStates[messageID] = Self.state(messageID, asset: asset, transcript: transcript, phase: .failed, error: "语音暂不可用")
        }
    }

    public func toggle(messageID: Int) {
        guard let state = messageStates[messageID] else { return }
        switch state.phase {
        case .playing: pause(messageID: messageID)
        case .paused: resume(messageID: messageID)
        case .ready, .stopped: startPlayback(messageID: messageID)
        case .loading, .failed, .expired: break
        }
    }
    public func pause(messageID: Int) { guard activeMessageID == messageID, messageStates[messageID]?.phase == .playing else { return }; player?.pause(); messageStates[messageID]?.phase = .paused }
    public func resume(messageID: Int) { guard activeMessageID == messageID, messageStates[messageID]?.phase == .paused else { return }; player?.play(); messageStates[messageID]?.phase = .playing }
    public func stop(messageID: Int? = nil) {
        if let messageID, activeMessageID != messageID { return }
        stopActive(markStopped: true)
    }

    private func stopActive(markStopped: Bool) {
        let active = activeMessageID
        generation = UUID(); progressTask?.cancel(); progressTask = nil; player?.stop(); player = nil
        if markStopped, let active, messageStates[active] != nil { messageStates[active]?.phase = .stopped; messageStates[active]?.currentTime = 0 }
        notifyAssistantAudioPlaying()
    }

    private func notifyAssistantAudioPlaying() {
        NotificationCenter.default.post(name: .companionAssistantAudioPlaying, object: isPlaying)
    }
    private func startPlayback(messageID: Int) {
        guard let data = audioByMessage[messageID] else { return }
        stopActive(markStopped: true)
        do {
            let audio = try AVAudioPlayer(data: data), token = generation
            player = audio; audio.prepareToPlay(); audio.play()
            messageStates[messageID]?.phase = .playing; messageStates[messageID]?.currentTime = 0
            notifyAssistantAudioPlaying()
            progressTask = Task { [weak self] in
                guard let self else { return }
                while !Task.isCancelled, generation == token {
                    if messageStates[messageID]?.phase == .paused { try? await Task.sleep(nanoseconds: 100_000_000); continue }
                    messageStates[messageID]?.currentTime = audio.currentTime
                    if !audio.isPlaying { break }
                    try? await Task.sleep(nanoseconds: 100_000_000)
                }
                guard generation == token else { return }
                messageStates[messageID]?.phase = .stopped
                messageStates[messageID]?.currentTime = messageStates[messageID]?.duration ?? audio.duration
                player = nil
                self.notifyAssistantAudioPlaying()
            }
        } catch { messageStates[messageID]?.phase = .failed; messageStates[messageID]?.errorText = "语音播放失败" }
    }

    private static func state(_ id: Int, asset: VoiceAsset, transcript: String, phase: VoiceBubblePhase, error: String? = nil) -> VoiceMessageState {
        VoiceMessageState(messageID: id, phase: phase, currentTime: 0, duration: asset.duration,
                          waveform: waveform(for: transcript), errorText: error, assetID: asset.voiceAssetID)
    }
    public static func waveform(for text: String, count: Int = 24) -> [Double] {
        var seed = text.unicodeScalars.reduce(UInt64(1_469_598_103_934_665_603)) { ($0 ^ UInt64($1.value)) &* 1_099_511_628_211 }
        return (0..<count).map { _ in seed = seed &* 6_364_136_223_846_793_005 &+ 1; return 0.25 + Double((seed >> 33) % 70) / 100 }
    }
}
