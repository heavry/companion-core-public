import AVFoundation
import Foundation

/// Chat Voice Message recorder：录一段 WAV，停止后交给 Core STT。
/// 与 VoiceCallManager（实时通话）完全分离。
@MainActor
public final class ChatVoiceMessageRecorder: ObservableObject {
    public enum Phase: Equatable { case idle, recording, stopping, sending, failed }

    @Published public private(set) var phase: Phase = .idle
    @Published public private(set) var elapsed: TimeInterval = 0
    @Published public private(set) var errorText: String?
    public private(set) var lastTranscript: String?

    private let api: APIClient
    private var engine: AVAudioEngine?
    private var file: AVAudioFile?
    private var samples: [AVAudioPCMBuffer] = []
    private var timer: Timer?
    private var startedAt: Date?
    private var lastWAV: Data?

    public init(api: APIClient) { self.api = api }

    public func toggle() {
        switch phase {
        case .idle, .failed: start()
        case .recording: Task { await stopAndSend() }
        case .stopping, .sending: break
        }
    }

    public func cancel() {
        guard phase == .recording else { return }
        stopCapture()
        phase = .idle
        elapsed = 0
        errorText = nil
        lastWAV = nil
    }

    public func start() {
        errorText = nil
        Task {
            let granted: Bool
            switch AVCaptureDevice.authorizationStatus(for: .audio) {
            case .authorized: granted = true
            case .notDetermined: granted = await AVCaptureDevice.requestAccess(for: .audio)
            default: granted = false
            }
            guard granted else {
                self.errorText = "需要在系统设置中允许 Companion 使用麦克风"
                self.phase = .failed
                return
            }
            self.beginCapture()
        }
    }

    private func beginCapture() {
        stopCapture()
        let engine = AVAudioEngine()
        let input = engine.inputNode
        let format = input.outputFormat(forBus: 0)
        samples.removeAll()
        startedAt = Date()
        elapsed = 0
        input.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] buffer, _ in
            guard let self, let copy = Self.copyBuffer(buffer) else { return }
            Task { @MainActor in self.samples.append(copy) }
        }
        do {
            try engine.start()
            self.engine = engine
            phase = .recording
            timer = Timer.scheduledTimer(withTimeInterval: 0.2, repeats: true) { [weak self] _ in
                Task { @MainActor in
                    guard let self, let start = self.startedAt else { return }
                    self.elapsed = Date().timeIntervalSince(start)
                }
            }
        } catch {
            errorText = "麦克风未能启动"
            phase = .failed
            stopCapture()
        }
    }

    public func stopAndSend() async {
        guard phase == .recording else { return }
        phase = .stopping
        let duration = elapsed
        guard duration >= 0.35 else {
            stopCapture()
            errorText = "录音太短，请再说一点"
            phase = .failed
            return
        }
        guard let wav = encodeWAV() else {
            stopCapture()
            errorText = "录音保存失败"
            phase = .failed
            return
        }
        lastWAV = wav
        lastTranscript = nil
        phase = .sending
        let started = Date()
        do {
            // Hard cap: never spin forever on STT/network.
            let result = try await withThrowingTaskGroup(of: APIClient.ChatVoiceMessageResponse.self) { group in
                group.addTask { try await self.api.sendChatVoiceMessage(wav: wav, durationMs: Int(duration * 1000)) }
                group.addTask {
                    try await Task.sleep(nanoseconds: 20_000_000_000)
                    throw URLError(.timedOut)
                }
                defer { group.cancelAll() }
                guard let first = try await group.next() else { throw URLError(.timedOut) }
                return first
            }
            NSLog("[voice-msg-ui] sendChatVoiceMessage ok in %.2fs transcript=%@", Date().timeIntervalSince(started), result.transcript ?? "")
            lastTranscript = result.transcript
            stopCapture()
            phase = .idle
            elapsed = 0
        } catch {
            NSLog("[voice-msg-ui] sendChatVoiceMessage failed in %.2fs err=%@", Date().timeIntervalSince(started), String(describing: error))
            stopCapture()
            errorText = (error as? URLError)?.code == .timedOut ? "转写超时，请重试" : "语音发送失败，未写入聊天"
            phase = .failed
        }
    }

    private func stopCapture() {
        timer?.invalidate(); timer = nil
        if let engine { engine.inputNode.removeTap(onBus: 0); engine.stop() }
        engine = nil
        startedAt = nil
    }

    private static func copyBuffer(_ buffer: AVAudioPCMBuffer) -> AVAudioPCMBuffer? {
        guard let copy = AVAudioPCMBuffer(pcmFormat: buffer.format, frameCapacity: buffer.frameCapacity) else { return nil }
        copy.frameLength = buffer.frameLength
        let channels = Int(buffer.format.channelCount)
        if let src = buffer.floatChannelData, let dst = copy.floatChannelData {
            for ch in 0..<channels {
                memcpy(dst[ch], src[ch], Int(buffer.frameLength) * MemoryLayout<Float>.size)
            }
        }
        return copy
    }

    private func encodeWAV() -> Data? {
        let buffers = samples
        guard !buffers.isEmpty, let first = buffers.first else { return nil }
        let format = first.format
        let sampleRate = Int(format.sampleRate)
        let channels = Int(format.channelCount)
        var pcm = [Int16]()
        pcm.reserveCapacity(Int(first.frameLength) * buffers.count * channels)
        for buffer in buffers {
            guard let data = buffer.floatChannelData else { continue }
            let frames = Int(buffer.frameLength)
            for f in 0..<frames {
                for ch in 0..<channels {
                    let v = max(-1, min(1, data[ch][f]))
                    pcm.append(Int16(v * Float(Int16.max)))
                }
            }
        }
        guard !pcm.isEmpty else { return nil }
        return Self.wavData(samples: pcm, sampleRate: sampleRate, channels: channels)
    }

    public static func wavData(samples: [Int16], sampleRate: Int, channels: Int) -> Data {
        let dataLength = samples.count * 2
        var data = Data()
        data.append(contentsOf: Array("RIFF".utf8))
        data.append(contentsOf: withUnsafeBytes(of: UInt32(36 + dataLength).littleEndian, Array.init))
        data.append(contentsOf: Array("WAVE".utf8))
        data.append(contentsOf: Array("fmt ".utf8))
        data.append(contentsOf: withUnsafeBytes(of: UInt32(16).littleEndian, Array.init))
        data.append(contentsOf: withUnsafeBytes(of: UInt16(1).littleEndian, Array.init))
        data.append(contentsOf: withUnsafeBytes(of: UInt16(channels).littleEndian, Array.init))
        data.append(contentsOf: withUnsafeBytes(of: UInt32(sampleRate).littleEndian, Array.init))
        data.append(contentsOf: withUnsafeBytes(of: UInt32(sampleRate * channels * 2).littleEndian, Array.init))
        data.append(contentsOf: withUnsafeBytes(of: UInt16(channels * 2).littleEndian, Array.init))
        data.append(contentsOf: withUnsafeBytes(of: UInt16(16).littleEndian, Array.init))
        data.append(contentsOf: Array("data".utf8))
        data.append(contentsOf: withUnsafeBytes(of: UInt32(dataLength).littleEndian, Array.init))
        for s in samples {
            data.append(contentsOf: withUnsafeBytes(of: s.littleEndian, Array.init))
        }
        return data
    }
}
