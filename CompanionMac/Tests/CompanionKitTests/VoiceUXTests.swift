import XCTest
@testable import CompanionKit

final class VoiceUXTests: XCTestCase {
    private func client() -> APIClient {
        APIClient(config: .init(baseURL: URL(string: "http://127.0.0.1:9")!, tokenProvider: { "" }))
    }

    private func silentWAV(seconds: Double = 1) -> Data {
        let sampleRate: UInt32 = 8_000, samples = UInt32(Double(sampleRate) * seconds), dataSize = samples * 2
        var data = Data()
        func ascii(_ value: String) { data.append(Data(value.utf8)) }
        func le16(_ value: UInt16) { var v = value.littleEndian; withUnsafeBytes(of: &v) { data.append(contentsOf: $0) } }
        func le32(_ value: UInt32) { var v = value.littleEndian; withUnsafeBytes(of: &v) { data.append(contentsOf: $0) } }
        ascii("RIFF"); le32(36 + dataSize); ascii("WAVEfmt "); le32(16); le16(1); le16(1); le32(sampleRate); le32(sampleRate * 2); le16(2); le16(16); ascii("data"); le32(dataSize)
        data.append(Data(repeating: 0, count: Int(dataSize)))
        return data
    }

    private func asset(id: String = "voice-ready", state: String = "ready") -> VoiceAsset {
        VoiceAsset(voiceAssetID: id, duration: 1, state: state, createdAt: "2026-08-30T00:00:00Z", url: "/media/\(id)")
    }

    @MainActor
    func testReadyAssetFirstClickPlaybackAndReplayNeverSynthesizes() async {
        let wav = silentWAV(); var loads = 0
        let manager = VoicePlaybackManager(api: client(), loadAudio: { id in loads += 1; XCTAssertEqual(id, "voice-ready"); return wav })
        await manager.prepare(messageID: 42, asset: asset(), transcript: "测试成功了。")
        XCTAssertEqual(manager.state(for: 42)?.phase, .ready)
        XCTAssertEqual(loads, 1)
        manager.toggle(messageID: 42); XCTAssertEqual(manager.state(for: 42)?.phase, .playing)
        manager.pause(messageID: 42); XCTAssertEqual(manager.state(for: 42)?.phase, .paused)
        manager.resume(messageID: 42); XCTAssertEqual(manager.state(for: 42)?.phase, .playing)
        manager.stop(messageID: 42); XCTAssertEqual(manager.state(for: 42)?.phase, .stopped)
        manager.toggle(messageID: 42); XCTAssertEqual(manager.state(for: 42)?.phase, .playing)
        XCTAssertEqual(loads, 1, "Playback and replay reuse the persisted asset; click never calls synthesis")
        manager.stop()
    }

    @MainActor
    func testFailedOrExpiredAssetCannotRetryOrResynthesize() async {
        enum FixtureError: Error { case unavailable }
        var loads = 0
        let manager = VoicePlaybackManager(api: client(), loadAudio: { _ in loads += 1; throw FixtureError.unavailable })
        await manager.prepare(messageID: 7, asset: asset(), transcript: "保留文字")
        XCTAssertEqual(manager.state(for: 7)?.phase, .failed)
        manager.toggle(messageID: 7); manager.toggle(messageID: 7)
        XCTAssertEqual(loads, 1, "A failed playback asset has no click-to-synthesize fallback")
        await manager.prepare(messageID: 8, asset: asset(id: "expired", state: "expired"), transcript: "历史文字")
        XCTAssertEqual(manager.state(for: 8)?.phase, .expired)
        manager.toggle(messageID: 8)
        XCTAssertEqual(loads, 1)
    }

    @MainActor
    func testNewUserTurnInterruptsOldPlayback() async {
        let manager = VoicePlaybackManager(api: client(), loadAudio: { _ in self.silentWAV(seconds: 2) })
        await manager.prepare(messageID: 9, asset: asset(), transcript: "旧语音")
        manager.toggle(messageID: 9); XCTAssertEqual(manager.state(for: 9)?.phase, .playing)
        manager.stop(); XCTAssertEqual(manager.state(for: 9)?.phase, .stopped)
    }

    @MainActor
    func testWaveformIsDeterministicAndCheap() {
        XCTAssertEqual(VoicePlaybackManager.waveform(for: "同一条消息"), VoicePlaybackManager.waveform(for: "同一条消息"))
        XCTAssertEqual(VoicePlaybackManager.waveform(for: "同一条消息").count, 24)
    }

    private func remotePlan(id: String = "turn-1:0") -> RemoteVoicePlan {
        RemoteVoicePlan(schemaVersion: 1, generationID: id, bubbleTurnID: "turn-1",
                        bubbleIndex: 0, bubbleCount: 1, text: "远程语音测试",
                        voiceRequested: true, voiceProfile: "linxt30",
                        voiceStyle: "warm", emotion: nil)
    }

    @MainActor
    func testRemoteVoicePlanSynthesizesOnceAndUsesDurableCache() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = RemoteVoicePlanStore(directory: directory)
        var synthesisCount = 0
        let manager = VoicePlaybackManager(api: client(), loadAudio: { _ in Data() }, synthesizeRemote: { _ in
            synthesisCount += 1
            return self.silentWAV()
        }, remoteStore: store)
        let row = ConversationMessagesResponse.Row(
            id: 88, role: "assistant", contentText: "远程语音测试", toolCallsJson: nil,
            toolCallId: nil, createdAt: nil, attachments: nil, voicePlan: remotePlan()
        )
        await manager.prepare(rows: [row])
        await manager.prepare(rows: [row])
        XCTAssertEqual(synthesisCount, 1)
        XCTAssertEqual(manager.state(for: 88)?.phase, .ready)

        let restored = VoicePlaybackManager(api: client(), loadAudio: { _ in Data() }, synthesizeRemote: { _ in
            synthesisCount += 1
            return self.silentWAV()
        }, remoteStore: RemoteVoicePlanStore(directory: directory))
        await restored.prepare(rows: [row])
        XCTAssertEqual(synthesisCount, 1, "App reload must reuse local WAV and never synthesize the same generation twice")
    }

    @MainActor
    func testRemoteVoiceFailureFallsBackToTextWithoutRetryingChat() async {
        enum FixtureError: Error { case down }
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        var synthesisCount = 0
        let manager = VoicePlaybackManager(api: client(), loadAudio: { _ in Data() }, synthesizeRemote: { _ in
            synthesisCount += 1
            throw FixtureError.down
        }, remoteStore: RemoteVoicePlanStore(directory: directory))
        let row = ConversationMessagesResponse.Row(
            id: 89, role: "assistant", contentText: "文字仍然存在", toolCallsJson: nil,
            toolCallId: nil, createdAt: nil, attachments: nil, voicePlan: remotePlan(id: "turn-2:0")
        )
        await manager.prepare(rows: [row])
        XCTAssertEqual(manager.state(for: 89)?.phase, .failed)
        XCTAssertEqual(synthesisCount, 1)
        XCTAssertEqual(row.contentText, "文字仍然存在")
    }

    func testChatVoiceFirstForAssistantTTSButNeverDeletesText() throws {
        let packageRoot = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let chat = try String(contentsOf: packageRoot.appendingPathComponent("Sources/CompanionMac/Views/ChatView.swift"), encoding: .utf8)
        let home = try String(contentsOf: packageRoot.appendingPathComponent("Sources/CompanionMac/Views/ChatHomeView.swift"), encoding: .utf8)
        XCTAssertFalse(chat.contains("speaker.wave.1")); XCTAssertFalse(chat.contains("生成本地语音")); XCTAssertFalse(chat.contains("鱼筱"))
        XCTAssertTrue(chat.contains("voiceAttachment"))
        XCTAssertTrue(chat.contains("voiceFirstBody"), "assistant TTS uses voice-first card")
        XCTAssertTrue(chat.contains("查看文字") && chat.contains("隐藏文字"), "transcript toggle required")
        XCTAssertTrue(chat.contains("transcriptExpanded"), "transcript state is local to the voice row")
        // Ordinary text remains for text-only and TTS-failure fallback paths.
        XCTAssertTrue(chat.contains("showOrdinaryTextBubble"))
        XCTAssertFalse(home.contains("voice.request")); XCTAssertFalse(home.contains("synthesizeVoice"))
    }

    @MainActor
    func testVoiceReadyAutoplayRespectsFreshness() async {
        let manager = VoicePlaybackManager(api: client(), loadAudio: { _ in self.silentWAV(seconds: 0.2) })
        manager.noteUserTurn(messageID: 100)
        manager.handleVoiceReady(VoiceReadyPayload(
            messageID: 50,
            voiceAsset: asset(),
            shouldAutoplay: true
        ))
        try? await Task.sleep(nanoseconds: 80_000_000)
        XCTAssertNotEqual(manager.state(for: 50)?.phase, .playing, "stale voice ready must not autoplay")

        manager.handleVoiceReady(VoiceReadyPayload(
            messageID: 120,
            voiceAsset: asset(id: "fresh"),
            shouldAutoplay: true
        ))
        try? await Task.sleep(nanoseconds: 80_000_000)
        XCTAssertEqual(manager.state(for: 120)?.phase, .playing, "fresh should_autoplay may play")
        manager.stop()
    }
}
