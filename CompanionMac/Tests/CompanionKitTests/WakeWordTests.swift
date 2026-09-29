import XCTest
@testable import CompanionKit

final class WakeWordTests: XCTestCase {
    func testDefaultsStayOffAndDoNotPersistAudio() {
        XCTAssertFalse(WakeWordPrivacy.defaultEnabled)
        XCTAssertFalse(WakeWordPrivacy.persistAmbientAudio)
        XCTAssertFalse(WakeWordPrivacy.writesToSharedMemory)
        XCTAssertFalse(WakeWordPrivacy.createsAttentionOnWake)
        XCTAssertFalse(WakeWordPrivacy.productQualified)
        XCTAssertEqual(WakeWordPrivacy.phrase, "林小糖")
        XCTAssertEqual(WakeWordPrivacy.preRollSeconds, 0.9)
    }

    func testPhraseStrippingAndCommands() {
        XCTAssertEqual(WakeWordLifecycle.strip("林小糖帮我打开 TextEdit"), "帮我打开 TextEdit")
        XCTAssertEqual(WakeWordLifecycle.strip("林小糖，现在几点？"), "现在几点？")
        XCTAssertEqual(WakeWordLifecycle.classify("林小糖，进入语音通话"), .startCall)
        XCTAssertEqual(WakeWordLifecycle.classify("林小糖，开始语音通话"), .startCall)
        XCTAssertEqual(WakeWordLifecycle.classify("林小糖，跟我聊会儿"), .startCall)
        XCTAssertEqual(WakeWordLifecycle.classify("林小糖，先别听了"), .disableWake)
        XCTAssertEqual(WakeWordLifecycle.classify("关闭唤醒"), .disableWake)
        XCTAssertEqual(WakeWordLifecycle.classify("算了"), .cancel)
        XCTAssertEqual(WakeWordLifecycle.classify("没事了"), .cancel)
        XCTAssertEqual(WakeWordLifecycle.classify("林小糖"), .empty)
        XCTAssertEqual(WakeWordLifecycle.classify("林小糖，打开 TextEdit。"), .utterance)
        XCTAssertEqual(WakeWordLifecycle.persistUserText(command: .utterance, stripped: "打开 TextEdit"), "打开 TextEdit")
        XCTAssertNil(WakeWordLifecycle.persistUserText(command: .empty, stripped: ""))
        XCTAssertNil(WakeWordLifecycle.persistUserText(command: .startCall, stripped: "进入语音通话"))
        XCTAssertNil(WakeWordLifecycle.persistUserText(command: .cancel, stripped: "算了"))
    }

    func testDisabledDoesNotListenAndSleepNeverAutoResumes() {
        XCTAssertFalse(WakeWordLifecycle.shouldListen(enabled: false))
        XCTAssertTrue(WakeWordLifecycle.shouldListen(enabled: true))
        XCTAssertFalse(WakeWordLifecycle.shouldListen(enabled: true, locked: true))
        XCTAssertFalse(WakeWordLifecycle.shouldListen(enabled: true, sleeping: true))
        XCTAssertFalse(WakeWordLifecycle.shouldListen(enabled: true, voiceCallActive: true))
        XCTAssertFalse(WakeWordLifecycle.shouldResumeMicrophone(after: "launch", enabled: true))
        XCTAssertFalse(WakeWordLifecycle.shouldResumeMicrophone(after: "sleep", enabled: true))
        XCTAssertFalse(WakeWordLifecycle.shouldResumeMicrophone(after: "wake", enabled: true))
        XCTAssertFalse(WakeWordLifecycle.shouldResumeMicrophone(after: "lock", enabled: true))
        XCTAssertTrue(WakeWordLifecycle.shouldResumeMicrophone(after: "unlock", enabled: true, locked: false, sleeping: false))
        XCTAssertTrue(WakeWordLifecycle.shouldResumeMicrophone(after: "end_call", enabled: true))
        XCTAssertEqual(WakeWordLifecycle.threshold(for: "low"), 0.35)
        XCTAssertEqual(WakeWordLifecycle.threshold(for: "normal"), 0.25)
        XCTAssertEqual(WakeWordLifecycle.threshold(for: "high"), 0.18)
        XCTAssertEqual(WakeWordLifecycle.menuMicCopy(enabled: true, phase: .listening), "麦克风正在用于唤醒检测")
        XCTAssertNil(WakeWordLifecycle.menuMicCopy(enabled: false, phase: .disabled))
    }

    func testPreRollKeepsCommandAfterWakePhrase() {
        var buffer = VoicePreRollBuffer(capacitySamples: Int(0.9 * 16_000))
        buffer.append([Int16](repeating: 1, count: 20_000))
        XCTAssertEqual(buffer.snapshot().count, 14_400)
        XCTAssertEqual(WakeWordPhase.listening.title, "等待唤醒")
        XCTAssertEqual(WakeWordPhase.detected.title, "已唤醒")
        XCTAssertEqual(WakeWordPhase.capturing.title, "正在听")
        XCTAssertEqual(WakeWordPhase.answering.title, "正在回答")
        XCTAssertTrue(WakeWordPhase.listening.usesMicrophone)
        XCTAssertFalse(WakeWordPhase.disabled.usesMicrophone)
        XCTAssertFalse(WakeWordPhase.suspended.usesMicrophone)
    }

    @MainActor
    func testFakeSpotterOneShotTimeoutAndPlaybackGate() async {
        let api = APIClient(config: .init(baseURL: URL(string: "http://127.0.0.1:9")!, tokenProvider: { "" }))
        let spotter = FakeWakeSpotter()
        let runtime = WakeWordRuntime(api: api, spotter: spotter)
        var settings = WakeWordSettings()
        settings.enabled = false
        settings.feedbackSound = false
        runtime.applySettingsForTest(settings)
        XCTAssertEqual(runtime.phase, .disabled)
        await runtime.ingestTestFrame(rms: 0.2, duration: 0.1, hit: true)
        XCTAssertEqual(runtime.phase, .disabled)

        settings.enabled = true
        runtime.applySettingsForTest(settings)
        XCTAssertEqual(runtime.phase, .listening)
        runtime.setAssistantAudioPlaying(true)
        spotter.queuedHits = 8
        await runtime.ingestTestFrame(rms: 0.3, duration: 0.1, hit: true)
        XCTAssertEqual(runtime.phase, .listening)

        runtime.setAssistantAudioPlaying(false)
        runtime.applySettingsForTest(settings)
        await runtime.ingestTestFrame(rms: 0.02, duration: 0.1, hit: true)
        XCTAssertEqual(runtime.phase, .detected)
        await runtime.timeoutForTest()
        XCTAssertEqual(runtime.phase, .listening)
        XCTAssertEqual(runtime.lastCommand, .empty)

        let cancel = runtime.handleTranscriptForTest("林小糖，算了")
        XCTAssertEqual(cancel.0, .cancel)
        XCTAssertNil(cancel.1)
        let call = runtime.handleTranscriptForTest("林小糖，进入语音通话")
        XCTAssertEqual(call.0, .startCall)
        XCTAssertNil(call.1)
        let uttered = runtime.handleTranscriptForTest("林小糖，打开 TextEdit")
        XCTAssertEqual(uttered.0, .utterance)
        XCTAssertEqual(uttered.1, "打开 TextEdit")
    }

    func testSettingsCopyKeepsDefaultOffAndLocalOnly() throws {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let source = try String(contentsOf: root.appendingPathComponent("Sources/CompanionMac/Views/SettingsRootView.swift"), encoding: .utf8)
        XCTAssertTrue(source.contains("启用“林小糖”"))
        XCTAssertTrue(source.contains("开启后，Companion 会在本机持续监听唤醒词 ‘林小糖’。唤醒检测完全在本地完成。"))
        XCTAssertTrue(source.contains("Local only"))
        XCTAssertFalse(source.contains("/Users/example"))
        XCTAssertFalse(source.contains("sherpa-onnx-kws-zipformer"))
        let overlay = try String(contentsOf: root.appendingPathComponent("Sources/CompanionMac/Views/WakeOverlayView.swift"), encoding: .utf8)
        XCTAssertTrue(overlay.contains("正在听") || overlay.contains("wake.phase.title"))
        XCTAssertFalse(overlay.contains("SenseVoice"))
        XCTAssertFalse(overlay.contains("GPT-SoVITS"))
        let lifecycle = try String(contentsOf: root.appendingPathComponent("Sources/CompanionMac/AppLifecycle.swift"), encoding: .utf8)
        XCTAssertTrue(lifecycle.contains("暂停唤醒"))
        XCTAssertTrue(lifecycle.contains("麦克风正在用于唤醒检测"))
        XCTAssertEqual(lifecycle.components(separatedBy: "NSStatusBar.system.statusItem").count - 1, 1)
    }
}
