import XCTest
@testable import CompanionKit

final class MessagePresentationTests: XCTestCase {
    private func row(_ id: Int, role: String, text: String? = nil, calls: String? = nil,
                     callId: String? = nil, attachments: [MediaAttachment]? = nil,
                     sources: [WebSource]? = nil, activities: [ToolActivityMetadata]? = nil,
                     turnId: String? = nil, voiceAsset: VoiceAsset? = nil) -> ConversationMessagesResponse.Row {
        .init(id: id, role: role, contentText: text, toolCallsJson: calls, toolCallId: callId,
              createdAt: "2026-08-27T00:00:00Z", attachments: attachments,
              webSources: sources, toolActivities: activities, voiceAsset: voiceAsset, bubbleTurnId: turnId)
    }

    private func metadata(_ id: String, status: String, integration: String = "Playwright",
                          tool: String = "browser_navigate", detail: String? = "example.com") -> ToolActivityMetadata {
        .init(callId: id, status: status, sourceType: "mcp", sourceId: "playwright_3518",
              integrationName: integration, displayName: tool, detail: detail)
    }

    func testEmptyAssistantToolCallBecomesActivityNotBubble() {
        let items = MessagePresentationBuilder.build(rows: [row(1, role: "assistant", text: "", activities: [metadata("c1", status: "running")])])
        XCTAssertEqual(items.count, 1)
        XCTAssertEqual(items.filter(\.isNormalBubble).count, 0)
        XCTAssertEqual(items.first?.activityGroup?.activities.first?.headline, "正在使用 Playwright")
    }

    func testWhitespaceAssistantWithLegacyToolCallHasNoEmptyBubble() {
        let calls = #"[{"id":"c1","type":"function","function":{"name":"mcp_playwright_3518_browser_snapshot","arguments":"{}"}}]"#
        let items = MessagePresentationBuilder.build(rows: [row(1, role: "assistant", text: "   ", calls: calls)])
        XCTAssertEqual(items.filter(\.isNormalBubble).count, 0)
        XCTAssertEqual(items.first?.activityGroup?.activities.first?.integrationName, "Playwright")
        XCTAssertEqual(items.first?.activityGroup?.activities.first?.actionText, "读取页面")
    }

    func testRunningAndSuccessMergeByCallIdWithoutDuplicateRows() {
        let items = MessagePresentationBuilder.build(rows: [
            row(1, role: "assistant", activities: [metadata("c1", status: "running")]),
            row(2, role: "tool", text: "safe result", callId: "c1", activities: [metadata("c1", status: "success")])
        ])
        let activities = items.first?.activityGroup?.activities
        XCTAssertEqual(activities?.count, 1)
        XCTAssertEqual(activities?.first?.id, "c1")
        XCTAssertEqual(activities?.first?.status, .success)
        XCTAssertEqual(activities?.first?.actionText, "已打开网页")
    }

    func testRealtimeRunningAndSuccessUpdateSameActivity() {
        let activity: JSONValue = .dictionary([
            "source_type": .string("mcp"), "source_id": .string("playwright_3518"),
            "integration_name": .string("Playwright"), "display_name": .string("browser_navigate"),
            "detail": .string("example.com")
        ])
        let started = RealtimeEvent(type: "tool.started", eventId: "e1", at: "2026-08-27T00:00:01Z", sessionId: "s1",
                                    data: .dictionary(["callId": .string("live-call"), "activity": activity]))
        let completed = RealtimeEvent(type: "tool.completed", eventId: "e2", at: "2026-08-27T00:00:02Z", sessionId: "s1",
                                      data: .dictionary(["callId": .string("live-call"), "activity": activity]))
        let items = MessagePresentationBuilder.build(rows: [row(1, role: "user", text: "打开网页")],
                                                     realtimeEvents: [completed, started], sessionId: "s1")
        XCTAssertEqual(items.last?.activityGroup?.activities.count, 1)
        XCTAssertEqual(items.last?.activityGroup?.activities.first?.status, .success)
        XCTAssertEqual(items.last?.activityGroup?.activities.first?.detail, "example.com")
    }

    func testToolCompletionThenAssistantFinalStaysInOneStableTurn() {
        let activity: JSONValue = .dictionary(["integration_name": .string("Companion"),
            "display_name": .string("读取图片")])
        let started = RealtimeEvent(type: "tool.started", eventId: "e1", at: "2026-08-27T00:00:01Z",
            sessionId: "s1", data: .dictionary(["callId": .string("image-1"), "turnId": .string("s1:10"), "activity": activity]))
        let completed = RealtimeEvent(type: "tool.completed", eventId: "e2", at: "2026-08-27T00:00:02Z",
            sessionId: "s1", data: .dictionary(["callId": .string("image-1"), "turnId": .string("s1:10"), "activity": activity]))
        let user = row(10, role: "user", text: "/Users/example-5/a.png")
        let during = MessagePresentationBuilder.buildAssistantTurns(rows: [user], realtimeEvents: [started], sessionId: "s1")
        guard case .assistantTurn(let pending)? = during.last else { return XCTFail("missing pending assistant turn") }
        XCTAssertTrue(pending.messages.isEmpty)
        XCTAssertEqual(pending.activities.first?.compactText, "正在查看图片")
        let optimistic = MessagePresentationBuilder.buildAssistantTurns(rows: [
            row(-1, role: "user", text: "/Users/example-5/a.png"),
            row(-2, role: "assistant", text: "我看到了")], realtimeEvents: [started], sessionId: "s1")
        guard case .assistantTurn(let streaming)? = optimistic.last else { return XCTFail("optimistic reply split from tool status") }
        XCTAssertEqual(streaming.id, pending.id)
        XCTAssertEqual(streaming.messages.first?.contentText, "我看到了")

        let after = MessagePresentationBuilder.buildAssistantTurns(rows: [user,
            row(11, role: "assistant", text: "这张图片里有一只猫。", turnId: "s1:10")],
            realtimeEvents: [completed, started], sessionId: "s1")
        XCTAssertEqual(after.count, 2, "tool completion must not become a separate message row")
        guard case .assistantTurn(let finished)? = after.last else { return XCTFail("final reply missing from turn") }
        XCTAssertEqual(finished.id, pending.id)
        XCTAssertEqual(finished.activities.first?.status, .success)
        XCTAssertEqual(finished.activities.first?.compactText, "已查看图片")
        XCTAssertEqual(finished.messages.map(\.contentText), ["这张图片里有一只猫。"])
    }

    func testThreeToolsAndTwoFinalBubblesStayInOneTurn() {
        let user = row(20, role: "user", text: "看看并分析")
        let activities = ["image", "file", "search"].map { metadata($0, status: "success") }
        let items = MessagePresentationBuilder.buildAssistantTurns(rows: [user,
            row(21, role: "assistant", activities: activities),
            row(22, role: "assistant", text: "第一句。", turnId: "s1:20"),
            row(23, role: "assistant", text: "第二句。", turnId: "s1:20")])
        XCTAssertEqual(items.count, 2)
        guard case .assistantTurn(let turn)? = items.last else { return XCTFail("tool run split into rows") }
        XCTAssertEqual(turn.activities.count, 3)
        XCTAssertEqual(turn.messages.map(\.id), [22, 23])
    }

    func testToolCallPreambleAndFinalReplyShareAssistantTurn() {
        let items = MessagePresentationBuilder.buildAssistantTurns(rows: [
            row(40, role: "user", text: "看图片"),
            row(41, role: "assistant", text: "等下，我看看。", activities: [metadata("image", status: "running")]),
            row(42, role: "tool", text: "image loaded", callId: "image", activities: [metadata("image", status: "success")]),
            row(43, role: "assistant", text: "是一只猫。", turnId: "s1:40")])
        XCTAssertEqual(items.count, 2)
        guard case .assistantTurn(let turn)? = items.last else { return XCTFail("tool preamble split from final") }
        XCTAssertEqual(turn.messages.map(\.contentText), ["等下，我看看。", "是一只猫。"])
    }

    func testLegacyRealtimeCompletionStillPrecedesFinalReply() {
        let completed = RealtimeEvent(type: "tool.completed", eventId: "old-e2",
            at: "2026-08-27T00:00:02Z", sessionId: "s1",
            data: .dictionary(["callId": .string("old-image"), "name": .string("read_image"),
                               "activity": .dictionary(["integration_name": .string("Companion"),
                                                        "display_name": .string("读取图片")])]))
        let items = MessagePresentationBuilder.buildAssistantTurns(rows: [
            row(10, role: "user", text: "/Users/example-5/old.png"),
            row(11, role: "assistant", text: "看到了。", turnId: "s1:10")],
            realtimeEvents: [completed], sessionId: "s1")
        XCTAssertEqual(items.count, 2)
        guard case .assistantTurn(let turn)? = items.last else { return XCTFail("legacy tool event was placed after the reply") }
        XCTAssertEqual(turn.activities.first?.compactText, "已查看图片")
        XCTAssertEqual(turn.messages.first?.contentText, "看到了。")
    }

    func testOrdinaryChatStillUsesPlainBubbles() {
        let items = MessagePresentationBuilder.buildAssistantTurns(rows: [
            row(30, role: "user", text: "你好"), row(31, role: "assistant", text: "你好呀")])
        XCTAssertEqual(items.count, 2)
        XCTAssertTrue(items.allSatisfy(\.isNormalBubble))
    }

    func testFailureShowsSafeSummaryWithoutStackTrace() {
        let items = MessagePresentationBuilder.build(rows: [
            row(1, role: "assistant", activities: [metadata("c1", status: "running")]),
            row(2, role: "tool", text: "Error: token=secret\nstack trace /Users/example-6/private.swift", callId: "c1",
                activities: [metadata("c1", status: "failed", detail: "Authorization: Bearer secret")])
        ])
        let activity = items.first?.activityGroup?.activities.first
        XCTAssertEqual(activity?.status, .failed)
        XCTAssertEqual(activity?.actionText, "操作失败")
        XCTAssertEqual(activity?.detail, "example.com", "失败状态可保留先前已验证的公开域名，但不能采用敏感错误详情")
        XCTAssertFalse(String(describing: items).contains("stack trace"))
        XCTAssertFalse(String(describing: items).contains("Bearer secret"))
    }

    func testNormalTextAndImageOnlyRemainVisible() {
        let attachment = MediaAttachment(mediaId: "m1", mime: "image/png", path: "/media/m1", width: 10, height: 10, bytes: 50)
        let items = MessagePresentationBuilder.build(rows: [
            row(1, role: "assistant", text: "正常回复"),
            row(2, role: "assistant", text: "", attachments: [attachment])
        ])
        XCTAssertTrue(items.contains { if case .bubble = $0 { return true }; return false })
        XCTAssertTrue(items.contains { if case .attachment = $0 { return true }; return false })
    }

    func testHistoryReloadRestoresCompletedActivity() {
        let calls = #"[{"id":"history-call","function":{"name":"mcp_playwright_3518_browser_find","arguments":"{}"}}]"#
        let items = MessagePresentationBuilder.build(rows: [
            row(1, role: "assistant", text: nil, calls: calls),
            row(2, role: "tool", text: "done", callId: "history-call")
        ])
        XCTAssertEqual(items.first?.activityGroup?.activities.first?.status, .success)
        XCTAssertEqual(items.filter(\.isNormalBubble).count, 0)
    }

    func testUnknownMcpToolNeverShowsRawNamespace() {
        let rawName = "mcp_private_abcd1234_dangerous_internal_operation"
        let calls = "[{\"id\":\"c1\",\"function\":{\"name\":\"\(rawName)\",\"arguments\":\"{}\"}}]"
        let items = MessagePresentationBuilder.build(rows: [row(1, role: "assistant", calls: calls)])
        let activity = items.first?.activityGroup?.activities.first
        XCTAssertEqual(activity?.integrationName, "Integration")
        XCTAssertFalse(activity?.headline.contains(rawName) ?? true)
        XCTAssertFalse(activity?.actionText.contains(rawName) ?? true)
    }

    func testSensitiveArgumentsAndDetailsNeverReachPresentation() {
        let calls = #"[{"id":"c1","function":{"name":"mcp_playwright_3518_browser_navigate","arguments":"{\"url\":\"https://example.com/?api_key=secret\",\"Authorization\":\"Bearer abc\",\"token\":\"secret\"}"}}]"#
        let items = MessagePresentationBuilder.build(rows: [
            row(1, role: "assistant", calls: calls,
                activities: [.init(callId: "c1", status: "running", sourceType: "mcp", sourceId: "p",
                                   integrationName: "Playwright", displayName: "browser_navigate",
                                   detail: "https://example.com/?api_key=secret")])
        ])
        let rendered = String(describing: items)
        XCTAssertFalse(rendered.contains("secret"))
        XCTAssertFalse(rendered.contains("api_key"))
        XCTAssertFalse(rendered.contains("Bearer abc"))
        XCTAssertNil(items.first?.activityGroup?.activities.first?.detail)
    }

    func testTavilyActivityAndSourcesBothRemainVisible() {
        let sources = [WebSource(title: "A", url: "https://a.example.com"), WebSource(title: "B", url: "https://b.example.com")]
        let items = MessagePresentationBuilder.build(rows: [
            row(1, role: "assistant", activities: [.init(callId: "s1", status: "running", sourceType: "core", sourceId: "tavily", integrationName: "Tavily", displayName: "web_search", detail: "Companion")]),
            row(2, role: "tool", text: "results", callId: "s1", activities: [.init(callId: "s1", status: "success", sourceType: "core", sourceId: "tavily", integrationName: "Tavily", displayName: "web_search", detail: "Companion")]),
            row(3, role: "assistant", text: "找到结果", sources: sources)
        ])
        XCTAssertEqual(items.first?.activityGroup?.activities.first?.integrationName, "联网搜索")
        XCTAssertEqual(items.first?.activityGroup?.activities.first?.actionText, "2 个来源")
        guard case .bubble(let final)? = items.last else { return XCTFail("final assistant bubble missing") }
        XCTAssertEqual(final.webSources?.count, 2)
    }

    func testConsecutiveToolCallsUseOneCompactGroup() {
        let items = MessagePresentationBuilder.build(rows: [
            row(1, role: "assistant", activities: [metadata("c1", status: "success", tool: "browser_navigate"),
                                                    metadata("c2", status: "success", tool: "browser_snapshot", detail: nil)]),
            row(2, role: "assistant", activities: [.init(callId: "c3", status: "success", sourceType: "core", sourceId: "tavily", integrationName: "Tavily", displayName: "web_search", detail: "Companion")]),
            row(3, role: "assistant", text: "最终回复")
        ])
        XCTAssertEqual(items.count, 2)
        XCTAssertEqual(items.first?.activityGroup?.activities.count, 3)
        XCTAssertTrue(items.last?.isNormalBubble ?? false)
    }


    func testNotionAndHomeAssistantFriendlyMappings() {
        let items = MessagePresentationBuilder.build(rows: [
            row(1, role: "assistant", activities: [.init(callId: "n1", status: "running", sourceType: "mcp", sourceId: "notion", integrationName: "Notion", displayName: "notion-search", detail: "项目")]),
            row(2, role: "assistant", text: "分隔"),
            row(3, role: "assistant", activities: [.init(callId: "h1", status: "success", sourceType: "mcp", sourceId: "ha", integrationName: "Home Assistant", displayName: "get_state", detail: "sensor.room")])
        ])
        XCTAssertEqual(items.first?.activityGroup?.activities.first?.headline, "正在查询 Notion")
        XCTAssertEqual(items.first?.activityGroup?.activities.first?.actionText, "搜索 Notion")
        XCTAssertEqual(items.last?.activityGroup?.activities.first?.integrationName, "Home Assistant")
        XCTAssertEqual(items.last?.activityGroup?.activities.first?.actionText, "已读取设备状态")
    }

    func testPendingApprovalAppearsAfterMatchingToolActivityAndSurvivesRebuild() {
        let request = SessionPermissionRequest(requestId: "p1", sessionId: "s1", callId: "c1",
            capabilityId: "mcp:notion:search", sourceType: "mcp", sourceId: "notion",
            integrationName: "Notion", displayName: "notion-search", scope: "read", riskLevel: "low",
            readOnly: true, reason: "current session requires approval", canAllowSession: true,
            createdAt: "2026-08-28T00:00:00Z", expiresAt: "2026-08-28T00:15:00Z", status: "pending")
        let rows = [row(1, role: "assistant", activities: [metadata("c1", status: "running", integration: "Notion", tool: "notion-search")])]
        let items = MessagePresentationBuilder.build(rows: rows, sessionId: "s1", pendingPermissions: [request])
        XCTAssertEqual(items.count, 2)
        guard case .approval(let approval) = items[1] else { return XCTFail("approval card missing") }
        XCTAssertEqual(approval.request.callId, "c1")
        XCTAssertTrue(approval.request.canAllowSession)
        XCTAssertEqual(MessagePresentationBuilder.build(rows: rows, sessionId: "s1", pendingPermissions: [request]), items)
    }

    func testProviderEntitlementFailureIsNotShownAsPermissionFailure() {
        let failed = ToolActivityMetadata(callId: "n1", status: "failed", sourceType: "mcp", sourceId: "notion",
            integrationName: "Notion", displayName: "notion-search-agents", failureCategory: "provider_error",
            failureCode: "provider_entitlement_required", failureSummary: "服务账号未开通此功能",
            failureReason: "当前服务套餐或账号权限不包含这个功能")
        let items = MessagePresentationBuilder.build(rows: [row(1, role: "tool", text: "safe", callId: "n1", activities: [failed])])
        let activity = items.first?.activityGroup?.activities.first
        XCTAssertEqual(activity?.actionText, "服务账号未开通此功能")
        XCTAssertEqual(activity?.failureCategory, "provider_error")
        XCTAssertNotEqual(activity?.actionText, "需要批准")
    }

    // MARK: - Voice-first presentation

    private func voiceAsset(_ id: String = "voice-1", state: String = "ready") -> VoiceAsset {
        VoiceAsset(voiceAssetID: id, duration: 2, state: state, url: "/media/\(id)")
    }

    func testTextOnlyAssistantStaysTextOnly() {
        let mode = VoiceMessagePresentation.displayMode(role: "assistant", text: "错什么错。", voiceAsset: nil, voicePlan: nil)
        XCTAssertEqual(mode, .textOnly)
    }

    func testAssistantTextPlusReadyVoiceIsVoiceFirst() {
        let mode = VoiceMessagePresentation.displayMode(role: "assistant", text: "错什么错。", voiceAsset: voiceAsset(), voicePlan: nil)
        XCTAssertEqual(mode, .voiceFirst)
    }

    func testPendingVoicePlanIsVoiceFirstWithoutTextFlip() {
        let plan = RemoteVoicePlan(schemaVersion: 1, generationID: "g1", bubbleTurnID: "s:1",
                                  bubbleIndex: 0, bubbleCount: 1, text: "错什么错。",
                                  voiceRequested: true, voiceProfile: "linxt30", voiceStyle: "happy", emotion: nil)
        let mode = VoiceMessagePresentation.displayMode(role: "assistant", text: "错什么错。", voiceAsset: nil, voicePlan: plan)
        XCTAssertEqual(mode, .voiceFirst)
    }

    func testFailedOrExpiredVoiceFallsBackToText() {
        XCTAssertEqual(VoiceMessagePresentation.displayMode(role: "assistant", text: "错什么错。", voiceAsset: voiceAsset(state: "failed")), .textFallback)
        XCTAssertEqual(VoiceMessagePresentation.displayMode(role: "assistant", text: "错什么错。", voiceAsset: voiceAsset(state: "expired")), .textFallback)
        XCTAssertTrue(VoiceMessagePresentation.shouldFallbackToText(mode: .voiceFirst, playbackFailed: true))
        XCTAssertFalse(VoiceMessagePresentation.shouldFallbackToText(mode: .voiceFirst, playbackFailed: false))
    }

    func testUserRowsNeverHideTextForVoice() {
        let mode = VoiceMessagePresentation.displayMode(role: "user", text: "你好", voiceAsset: voiceAsset(), voicePlan: nil)
        XCTAssertEqual(mode, .textOnly)
    }

    func testEmptyAssistantTextWithVoiceIsFallbackNotEmptyReply() {
        let mode = VoiceMessagePresentation.displayMode(role: "assistant", text: "   ", voiceAsset: voiceAsset(), voicePlan: nil)
        XCTAssertEqual(mode, .textFallback)
    }

    func testTwoAssistantBubblesRemainSeparateRowsInTurn() {
        let items = MessagePresentationBuilder.buildAssistantTurns(rows: [
            row(1, role: "user", text: "好好好姐姐没有不耐烦我错了姐姐"),
            row(2, role: "assistant", text: "第一句。", turnId: "s:1"),
            row(3, role: "assistant", text: "第二句。", turnId: "s:1", voiceAsset: voiceAsset("v2"))
        ])
        // Without tool activities each assistant bubble stays its own presentation row.
        let assistantTexts: [String] = items.compactMap {
            if case .bubble(let r) = $0, r.role == "assistant" { return r.contentText }
            return nil
        }
        XCTAssertEqual(assistantTexts, ["第一句。", "第二句。"], "two bubbles must not merge")
        XCTAssertEqual(items.filter(\.isNormalBubble).count, 3) // user + 2 assistant
        // First text-only, second voice-first — never merged into one presentation.
        XCTAssertEqual(VoiceMessagePresentation.displayMode(role: "assistant", text: "第一句。", voiceAsset: nil), .textOnly)
        XCTAssertEqual(VoiceMessagePresentation.displayMode(role: "assistant", text: "第二句。", voiceAsset: voiceAsset("v2")), .voiceFirst)
    }
}
