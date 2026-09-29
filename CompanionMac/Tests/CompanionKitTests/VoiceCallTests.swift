import XCTest
@testable import CompanionKit

final class VoiceCallTests: XCTestCase {
    func testEndpointNeedsMinimumSpeechAndTrailingSilence() {
        var detector = VoiceEndpointDetector()
        XCTAssertFalse(detector.observe(rms: 0.03, duration: 0.1))
        XCTAssertFalse(detector.observe(rms: 0.03, duration: 0.16))
        XCTAssertFalse(detector.observe(rms: 0, duration: 0.5))
        XCTAssertTrue(detector.observe(rms: 0, duration: 0.16))
    }
    func testNoiseAndBriefPauseDoNotEndUtterance() {
        var detector = VoiceEndpointDetector()
        for _ in 0..<20 { XCTAssertFalse(detector.observe(rms: 0.005, duration: 0.05)) }
        for _ in 0..<6 { _ = detector.observe(rms: 0.03, duration: 0.05) }
        XCTAssertFalse(detector.observe(rms: 0, duration: 0.4))
        XCTAssertFalse(detector.observe(rms: 0.03, duration: 0.1))
    }
    func testWAVEncodingIsValid() {
        let data = VoiceCallManager.wav(samples: [0, 1, -1], sampleRate: 16_000, channels: 1)
        XCTAssertEqual(String(data: data.prefix(4), encoding: .ascii), "RIFF")
        XCTAssertEqual(String(data: data.dropFirst(8).prefix(4), encoding: .ascii), "WAVE")
        XCTAssertEqual(data.count, 50)
    }
    func testCallStatesExposeTransparentLifecycle() {
        XCTAssertEqual(VoiceCallPhase.allTestCases.map(\.title), [
            "未通话","正在准备本地语音…","正在听","你正在说话","正在理解","正在理解",
            "林小糖正在说话","你正在说话","通话已暂停","语音通话遇到问题"
        ])
    }
    func testHandsFreeLifecycleMuteSleepAndDeviceChange() {
        XCTAssertTrue(VoiceCallLifecycle.shouldSuppressSpeechTurns(isMuted: true))
        XCTAssertFalse(VoiceCallLifecycle.shouldSuppressSpeechTurns(isMuted: false))
        XCTAssertEqual(VoiceCallLifecycle.afterStop(), .listening)
        XCTAssertEqual(VoiceCallLifecycle.afterEnd(), .idle)
        XCTAssertEqual(VoiceCallLifecycle.afterSleep(), .paused)
        XCTAssertFalse(VoiceCallLifecycle.shouldResumeMicrophone(after: "launch"))
        XCTAssertFalse(VoiceCallLifecycle.shouldResumeMicrophone(after: "wake"))
        XCTAssertFalse(VoiceCallLifecycle.shouldResumeMicrophone(after: "end"))
        XCTAssertEqual(VoiceCallLifecycle.deviceChangeAction(canRebuild: true).message, nil)
        XCTAssertEqual(VoiceCallLifecycle.deviceChangeAction(canRebuild: false).message, "音频设备已变化，请继续通话")
    }
    func testSimulatedThirtyMinuteCallDoesNotGrowUnbounded() {
        var detector = VoiceEndpointDetector()
        var floor = AdaptiveNoiseFloor()
        var preroll = VoicePreRollBuffer(capacitySamples: 4_480)
        var samples = 0
        var turns = 0
        for i in 0..<90_000 {
            let cycle = (Double(i) * 0.02).truncatingRemainder(dividingBy: 12)
            let rms: Float = cycle < 0.2 ? 0.2 : cycle < 3 ? 0.03 : cycle < 4 ? 0.0 : 0.002
            floor.observe(rms: rms, duration: 0.02, isVoiced: rms >= 0.014)
            detector.speechThreshold = floor.threshold
            preroll.append([Int16(i % 8)])
            XCTAssertLessThanOrEqual(preroll.snapshot().count, 4_480)
            if detector.observe(rms: rms, duration: 0.02) {
                turns += 1
                detector.reset()
                samples = 0
            } else {
                samples += 1
                XCTAssertLessThan(samples, 1_200)
            }
        }
        XCTAssertTrue(floor.calibrated)
        XCTAssertGreaterThan(turns, 0)
    }
    func testCallSurfaceHidesTechnicalDiagnostics() throws {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let source = try String(contentsOf: root.appendingPathComponent("Sources/CompanionMac/Views/VoiceCallSurface.swift"), encoding: .utf8)
        XCTAssertFalse(source.contains("SenseVoice"))
        XCTAssertFalse(source.contains("GPT-SoVITS"))
        XCTAssertFalse(source.contains("yuxiao"))
        XCTAssertFalse(source.contains("鱼筱"))
        XCTAssertFalse(source.contains("RMS"))
        XCTAssertTrue(source.contains("已静音"))
        XCTAssertTrue(source.contains("结束"))
    }
    func testBargeInNeedsSustainedSpeechAndRejectsPlaybackStartup() {
        var gate = VoiceBargeInGate()
        XCTAssertFalse(gate.observe(rms: 0.3, assistantLevel: 0.1, playbackAge: 0.2, duration: 0.2))
        XCTAssertFalse(gate.observe(rms: 0.22, assistantLevel: 0.1, playbackAge: 0.5, duration: 0.08))
        XCTAssertTrue(gate.observe(rms: 0.22, assistantLevel: 0.1, playbackAge: 0.6, duration: 0.09))
        gate.reset(); XCTAssertFalse(gate.observe(rms: 0.09, assistantLevel: 0.2, playbackAge: 1, duration: 0.3))
    }
    func testAdaptiveNoiseFloorCalibratesAndStaysClamped() {
        var floor = AdaptiveNoiseFloor()
        for _ in 0..<30 { floor.observe(rms: 0.002, duration: 0.05, isVoiced: false) }
        XCTAssertTrue(floor.calibrated)
        XCTAssertGreaterThanOrEqual(floor.threshold, floor.minThreshold)
        XCTAssertLessThan(floor.threshold, 0.02)
        for _ in 0..<80 { floor.observe(rms: 0.0001, duration: 0.05, isVoiced: false) }
        XCTAssertGreaterThanOrEqual(floor.threshold, floor.minThreshold)
        var noisy = AdaptiveNoiseFloor()
        for _ in 0..<30 { noisy.observe(rms: 0.014, duration: 0.05, isVoiced: false) }
        XCTAssertLessThanOrEqual(noisy.threshold, noisy.maxThreshold)
        XCTAssertGreaterThan(noisy.threshold, 0.02)
    }
    func testPreRollKeepsLeadingSyllableAndPostRollKeepsTail() {
        var buffer = VoicePreRollBuffer(capacitySamples: 4)
        buffer.append([1, 2, 3, 4, 5, 6])
        XCTAssertEqual(buffer.snapshot(), [3, 4, 5, 6])
        XCTAssertEqual(buffer.take(), [3, 4, 5, 6])
        XCTAssertTrue(buffer.snapshot().isEmpty)
        var detector = VoiceEndpointDetector()
        for _ in 0..<6 { _ = detector.observe(rms: 0.03, duration: 0.05) }
        XCTAssertTrue(detector.hasSpeech)
        XCTAssertFalse(detector.observe(rms: 0, duration: 0.18))
        XCTAssertEqual(detector.state, .shortPause)
        XCTAssertGreaterThanOrEqual(detector.silenceSeconds, detector.postRollSeconds)
    }
    func testShortPauseDoesNotConfirmAndLongUtteranceAllowsNaturalPause() {
        var short = VoiceEndpointDetector()
        for _ in 0..<6 { _ = short.observe(rms: 0.03, duration: 0.05) }
        XCTAssertEqual(short.state, .speaking)
        XCTAssertFalse(short.observe(rms: 0, duration: 0.25))
        XCTAssertEqual(short.state, .shortPause)
        XCTAssertFalse(short.observe(rms: 0, duration: 0.2))
        XCTAssertEqual(short.state, .possibleEnd)
        XCTAssertTrue(short.observe(rms: 0, duration: 0.2))
        XCTAssertEqual(short.state, .confirmedEnd)
        var long = VoiceEndpointDetector()
        for _ in 0..<80 { _ = long.observe(rms: 0.03, duration: 0.05) }
        XCTAssertFalse(long.observe(rms: 0, duration: 0.7))
        XCTAssertEqual(long.state, .possibleEnd)
        XCTAssertTrue(long.observe(rms: 0, duration: 0.3))
    }
    func testSilenceAndKeyboardClicksDoNotCreateTurns() {
        var detector = VoiceEndpointDetector()
        var ended = false
        for _ in 0..<600 { ended = detector.observe(rms: 0.001, duration: 0.05) || ended }
        XCTAssertFalse(ended)
        XCTAssertFalse(detector.hasSpeech)
        var click = VoiceEndpointDetector()
        XCTAssertFalse(click.observe(rms: 0.2, duration: 0.04))
        XCTAssertFalse(click.hasSpeech)
        XCTAssertFalse(click.observe(rms: 0, duration: 0.8))
    }
    func testNativeResample48kTo16kIsDeterministic() {
        let input = [Float](repeating: 0.5, count: 480)
        let output = VoiceAudioResampler.resample(input, from: 48_000, to: 16_000)
        XCTAssertEqual(output.count, 160)
        XCTAssertEqual(VoiceAudioResampler.rms(output), 0.5, accuracy: 0.01)
        XCTAssertEqual(VoiceAudioResampler.pcm16([1, -1, 0]).count, 3)
    }
    func testHighQualitySentenceQueueOmitsCodeAndURLs() {
        let queue = VoiceCallManager.sentenceQueue("你好。```secret```请查看 https://example.com 完成！")
        XCTAssertEqual(queue, ["你好", "请查看 完成"])
    }
    func testSentenceStabilizerCommitsBeforeFinalAndSkipsCode() {
        var stabilizer = SpeechChunkStabilizer()
        XCTAssertEqual(stabilizer.consume("我"), [])
        XCTAssertEqual(stabilizer.consume("觉得"), [])
        XCTAssertEqual(stabilizer.consume("这个。"), ["我觉得这个"])
        XCTAssertEqual(stabilizer.consume("```secret```请查看 https://example.com 完成！"), ["请查看 完成"])
        XCTAssertEqual(stabilizer.consume("还没说完"), [])
        XCTAssertEqual(stabilizer.finish(), ["还没说完"])
    }
    func testFirstSentenceStartsBeforeAssistantFinal() {
        var stabilizer = SpeechChunkStabilizer()
        XCTAssertEqual(stabilizer.consume("我看到了，现在有六个窗口。"), ["我看到了，现在有六个窗口"])
        XCTAssertEqual(stabilizer.consume("后面还有。"), ["后面还有"])
        XCTAssertEqual(stabilizer.finish(), [])
    }
    func testShortInterjectionWaitsForFinalFlushWhileOrdinaryFragmentsStayBuffered() {
        for fragment in ["我", "你", "这", "的", "了", "是"] {
            var stabilizer = SpeechChunkStabilizer()
            XCTAssertEqual(stabilizer.consume(fragment), [], "ordinary fragment must not emit before final")
        }
        for interjection in ["啊", "嗯", "呵", "哈", "唉", "哦", "欸", "哼", "嗯哼", "哈哈", "啊……", "嗯……", "唉……", "哦——"] {
            var stabilizer = SpeechChunkStabilizer()
            XCTAssertEqual(stabilizer.consume(interjection), [], "unterminated interjection waits for final")
            XCTAssertEqual(stabilizer.finish(), [interjection], "final flush keeps standalone interjection")
        }
        var punctuated = SpeechChunkStabilizer()
        XCTAssertEqual(punctuated.consume("哈！"), ["哈"])
        XCTAssertEqual(punctuated.finish(), [])
    }
    func testVoiceCallDefaultsToSpeechButExplicitTextOnlyWins() {
        XCTAssertTrue(VoiceCallManager.shouldSpeak(userTranscript: "告诉我今天的天气"))
        XCTAssertFalse(VoiceCallManager.shouldSpeak(userTranscript: "这次打字就行"))
        XCTAssertFalse(VoiceCallManager.shouldSpeak(userTranscript: "不要语音，只打字"))
    }
    func testTurnMetricsComputePipelineLatenciesWithoutAudio() {
        var metrics = VoiceTurnMetrics(callSessionId: "c1", turnId: "t1")
        let t0 = Date(timeIntervalSince1970: 1_000)
        metrics.speechStart = t0
        metrics.speechEnd = t0.addingTimeInterval(1.2)
        metrics.endpointDetected = t0.addingTimeInterval(1.85)
        metrics.sttStart = t0.addingTimeInterval(1.86)
        metrics.sttFinal = t0.addingTimeInterval(2.20)
        metrics.agentRequestStart = t0.addingTimeInterval(2.21)
        metrics.agentFirstToken = t0.addingTimeInterval(2.71)
        metrics.agentFinal = t0.addingTimeInterval(3.21)
        metrics.ttsRequestStart = t0.addingTimeInterval(2.80)
        metrics.ttsFirstAudio = t0.addingTimeInterval(3.70)
        metrics.playbackStart = t0.addingTimeInterval(3.72)
        metrics.bargeInDetected = t0.addingTimeInterval(4.00)
        metrics.playbackStopped = t0.addingTimeInterval(4.04)
        metrics.finalizeDurations()
        XCTAssertEqual(metrics.endpointMs, 650)
        XCTAssertEqual(metrics.sttMs, 340)
        XCTAssertEqual(metrics.agentTTFTMs, 500)
        XCTAssertEqual(metrics.agentFinalMs, 1_000)
        XCTAssertEqual(metrics.ttsFirstAudioMs, 900)
        XCTAssertEqual(metrics.speechEndToFirstAudioMs, 2_520)
        XCTAssertEqual(metrics.bargeInStopMs, 40)
        let payload = metrics.diagnosticsPayload()
        XCTAssertNil(payload["transcript"])
        XCTAssertNil(payload["audio_base64"])
        XCTAssertNil(payload["emotion"])
        XCTAssertEqual(payload["endpoint_ms"] as? Double, 650)
        XCTAssertEqual(payload["call_session_id"] as? String, "c1")
    }
    func testBargeInLatencyPercentiles() {
        XCTAssertEqual(VoiceTurnMetrics.p50([10, 40, 20, 80, 30]), 30)
        XCTAssertEqual(VoiceTurnMetrics.p90([10, 40, 20, 80, 30]), 80)
        XCTAssertNil(VoiceTurnMetrics.p50([]))
    }
    func testHandsFreeNeverAutoResumesMicrophone() {
        XCTAssertFalse(VoiceCallPolicy.resumesMicrophoneAfterLaunch)
        XCTAssertFalse(VoiceCallPolicy.resumesMicrophoneAfterWake)
        XCTAssertFalse(VoiceCallPolicy.listensOutsideCall)
    }
}
private extension VoiceCallPhase { static var allTestCases: [VoiceCallPhase] { [.idle,.starting,.listening,.userSpeaking,.transcribing,.thinking,.assistantSpeaking,.interrupted,.paused,.error] } }
