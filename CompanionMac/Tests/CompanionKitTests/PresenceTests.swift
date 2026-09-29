import XCTest
import Carbon
@testable import CompanionKit

final class PresenceTests: XCTestCase {
    func testMainWindowCloseDoesNotQuitRuntime() {
        XCTAssertFalse(PresenceLifecycle.terminatesAfterLastWindowClosed)
        XCTAssertTrue(PresenceLifecycle.stopsOwnedRuntimeOnQuit)
        XCTAssertTrue(PresenceLifecycle.keepsVoiceCallWhenMainWindowCloses)
        XCTAssertFalse(PresenceLifecycle.allowsBackgroundScreenshots)
        XCTAssertFalse(PresenceLifecycle.allowsBackgroundMicrophone)
    }

    func testHotkeyDefaultIsOptionSpaceNotSpotlight() {
        XCTAssertEqual(GlobalHotkey.Chord.optionSpace.keyCode, 49)
        XCTAssertEqual(GlobalHotkey.Chord.optionSpace.carbonModifiers, UInt32(optionKey))
        XCTAssertNotEqual(GlobalHotkey.Chord.optionSpace.carbonModifiers, UInt32(cmdKey))
        XCTAssertTrue(GlobalHotkey.Chord.optionSpace.displayName.contains("⌥"))
        XCTAssertTrue(GlobalHotkey.Chord.optionSpace.displayName.contains("Space"))
    }

    func testHotkeyToggleQuickChat() {
        var visible = false
        func toggle() { visible.toggle() }
        toggle()
        XCTAssertTrue(visible)
        toggle()
        XCTAssertFalse(visible)
    }

    func testQuickChatUsesExistingChatStore() {
        XCTAssertTrue(PresenceAction.quickChat.usesExistingChatStore)
        XCTAssertTrue(PresenceAction.askScreen.usesExistingChatStore)
        XCTAssertFalse(PresenceAction.quit.usesExistingChatStore)
    }

    func testWorkspaceSelectionUsesOneExplicitSessionTruthAcrossChatSurfaces() {
        XCTAssertEqual(WorkspaceSelectionPolicy.sharedSessionKey, "chat:default")
        XCTAssertTrue(WorkspaceSelectionPolicy.mainChatUsesSessionTruth)
        XCTAssertTrue(WorkspaceSelectionPolicy.quickChatUsesSessionTruth)
        XCTAssertTrue(WorkspaceSelectionPolicy.menuBarQuickChatUsesSessionTruth)
        XCTAssertFalse(WorkspaceSelectionPolicy.defaultsToHome)
        XCTAssertFalse(WorkspaceSelectionPolicy.defaultsToRoot)
    }

    func testAskScreenRequiresExplicitTrigger() {
        XCTAssertTrue(ScreenContextPolicy.requiresExplicitTrigger)
        XCTAssertFalse(ScreenContextPolicy.allowsBackgroundCapture)
        XCTAssertFalse(ScreenContextPolicy.writesToSharedMemory)
        XCTAssertFalse(ScreenContextPolicy.persistScreenshots)
    }

    func testPresenceStatusMapping() {
        XCTAssertEqual(PresenceStatus.resolve(connected: true, agentRunning: false, pendingApproval: false, voice: .idle), .online)
        XCTAssertEqual(PresenceStatus.resolve(connected: true, agentRunning: true, pendingApproval: false, voice: .idle), .usingTools)
        XCTAssertEqual(PresenceStatus.resolve(connected: true, agentRunning: false, pendingApproval: true, voice: .idle), .waitingApproval)
        XCTAssertEqual(PresenceStatus.resolve(connected: true, agentRunning: false, pendingApproval: false, voice: .listening), .voiceCall)
        XCTAssertEqual(PresenceStatus.resolve(connected: true, agentRunning: false, pendingApproval: false, voice: .assistantSpeaking), .speaking)
        XCTAssertEqual(PresenceStatus.voiceCall.title, "语音通话中")
        XCTAssertEqual(PresenceStatus.resolve(connected: true, agentRunning: false, pendingApproval: false, voice: .idle, wake: .listening), .wakeWaiting)
        XCTAssertEqual(PresenceStatus.resolve(connected: true, agentRunning: false, pendingApproval: false, voice: .idle, wake: .detected), .wakeDetected)
        XCTAssertEqual(PresenceStatus.resolve(connected: true, agentRunning: false, pendingApproval: false, voice: .idle, wake: .capturing), .wakeListening)
        XCTAssertEqual(PresenceStatus.resolve(connected: true, agentRunning: false, pendingApproval: false, voice: .idle, wake: .answering), .wakeAnswering)
        XCTAssertEqual(PresenceStatus.resolve(connected: true, agentRunning: false, pendingApproval: false, voice: .listening, wake: .listening), .voiceCall)
        XCTAssertEqual(PresenceStatus.wakeWaiting.title, "等待唤醒")
        XCTAssertEqual(PresenceStatus.wakeAnswering.title, "正在回答")
    }

    func testPresenceSettingsDefaultProactiveVoiceOffAndSummaryPreview() {
        let defaults = UserDefaults(suiteName: "presence-test-\(UUID().uuidString)")!
        let store = PresenceSettingsStore(defaults: defaults)
        XCTAssertEqual(store.settings.notificationPreview, .summary)
        XCTAssertFalse(store.settings.proactiveVoiceEnabled)
        var next = store.settings
        next.proactiveVoiceEnabled = true
        next.notificationPreview = .privatePreview
        store.settings = next
        XCTAssertTrue(store.settings.proactiveVoiceEnabled)
        XCTAssertEqual(store.settings.notificationPreview, .privatePreview)
    }

    func testNotificationPrivacyAndSafeActions() {
        let priv = NotificationService.privacyCopy(title:"任务完成了。", body:"测试已经跑完，输出在 /tmp/secret", preview: .privatePreview)
        XCTAssertEqual(priv.0, "林小糖")
        XCTAssertEqual(priv.1, "有一条新消息。")
        XCTAssertFalse(priv.1.contains("secret"))
        XCTAssertTrue(NotificationService.isUnsafeNotificationAction("APPROVE"))
        XCTAssertTrue(NotificationService.isUnsafeNotificationAction("SHELL"))
        XCTAssertFalse(NotificationService.isUnsafeNotificationAction("OPEN"))
        XCTAssertFalse(NotificationService.isUnsafeNotificationAction("SNOOZE"))
    }

    func testComposerIMEContractIsReturnToSendShiftReturnToBreak() throws {
        let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        let composer = try String(contentsOf: root.appendingPathComponent("Sources/CompanionMac/Views/ComposerTextView.swift"), encoding: .utf8)
        XCTAssertTrue(composer.contains("hasMarkedText()"))
        XCTAssertTrue(composer.contains("insertNewline"))
        let quick = try String(contentsOf: root.appendingPathComponent("Sources/CompanionMac/Views/QuickChatView.swift"), encoding: .utf8)
        XCTAssertTrue(quick.contains("ComposerTextView"))
        XCTAssertFalse(quick.contains("speaker.wave"))
        XCTAssertFalse(quick.contains("朗读"))
    }
}
