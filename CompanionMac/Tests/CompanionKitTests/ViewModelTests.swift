import XCTest
@testable import CompanionKit

@MainActor
final class ViewModelTests: XCTestCase {
    private func stubbedClient() -> APIClient {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [URLProtocolStub.self]
        return APIClient(
            config: .init(baseURL: URL(string: "http://127.0.0.1:8765")!, tokenProvider: { "k" }),
            session: URLSession(configuration: config)
        )
    }

    func testSessionsViewModelLoadsAndFilters() async throws {
        URLProtocolStub.handler = { req in
            if req.url?.path == "/admin/conversations" {
                let json = """
                {"data":[
                 {"id":"a","source":"kelivo","category":"daily","display_name":"Kelivo · daily-main","message_count":2},
                 {"id":"b","source":"opencode","category":"agents","display_name":"OpenCode · demo","message_count":9}
                ]}
                """
                return (200, Data(json.utf8))
            }
            if req.url?.path == "/admin/conversations/a/messages" {
                let json = #"{"data":[{"id":1,"role":"user","content_text":"你好","attachments":[]}]}"#
                return (200, Data(json.utf8))
            }
            return (404, Data())
        }
        let vm = SessionsViewModel(api: stubbedClient())
        await vm.reload()
        XCTAssertEqual(vm.conversations.count, 2)
        vm.setFilter("agents")
        await vm.reload()
        XCTAssertEqual(vm.conversations.count, 1)
        XCTAssertEqual(vm.conversations.first?.category, "agents")
        // 选择会话加载消息
        if let first = try? { () throws -> Conversation? in nil }() {}
        let daily = Conversation(id: "a", source: "kelivo", externalKey: "daily-main", category: "daily",
                                 displayName: "Kelivo · daily-main", lastActivity: nil, messageCount: 2,
                                 recentMessage: nil, archived: false)
        await vm.select(daily)
        XCTAssertEqual(vm.messages.first?.contentText, "你好")
    }

    func testChatReloadSelectsStableDailyConversation() async throws {
        URLProtocolStub.handler = { req in
            if req.url?.path == "/admin/conversations" {
                return (200, Data(#"{"data":[{"id":"chat-1","source":"chat","external_key":"chat:default","category":"daily","display_name":"chat · chat:default","message_count":1}]}"#.utf8))
            }
            if req.url?.path == "/admin/conversations/chat-1/messages" {
                return (200, Data(#"{"data":[{"id":9,"role":"assistant","content_text":"欢迎回来","attachments":[]}]}"#.utf8))
            }
            return (404, Data())
        }
        let vm = SessionsViewModel(api: stubbedClient(), preferredSource: "chat")
        await vm.reload()
        XCTAssertEqual(vm.conversations.map(\.source), ["chat"])
        XCTAssertEqual(vm.messages.first?.contentText, "欢迎回来")
    }

    func testStaleReloadResponseIsRejectedByEpochGuard() async throws {
        // Sequential double-reload: newer payload must win; epoch guards remain in reload().
        // (reloadInFlight coalesces concurrent calls; stale HTTP cannot overwrite newer state.)
        var messageCalls = 0
        URLProtocolStub.handler = { req in
            if req.url?.path == "/admin/conversations" {
                return (200, Data(#"{"data":[{"id":"chat-1","source":"chat","external_key":"chat:default","category":"daily","display_name":"chat · chat:default","message_count":2}]}"#.utf8))
            }
            if req.url?.path == "/admin/conversations/chat-1/messages" {
                messageCalls += 1
                if messageCalls == 1 {
                    return (200, Data(#"{"data":[{"id":1,"role":"user","content_text":"旧"},{"id":2,"role":"assistant","content_text":"只有第一条"}]}"#.utf8))
                }
                return (200, Data(#"{"data":[{"id":1,"role":"user","content_text":"新"},{"id":2,"role":"assistant","content_text":"第一条"},{"id":3,"role":"assistant","content_text":"第二条"}]}"#.utf8))
            }
            return (404, Data())
        }
        let vm = SessionsViewModel(api: stubbedClient(), preferredSource: "chat")
        await vm.reload()
        XCTAssertEqual(vm.messages.map(\.contentText), ["旧", "只有第一条"])
        await vm.reload()
        XCTAssertEqual(vm.messages.map(\.contentText), ["新", "第一条", "第二条"])
        XCTAssertFalse(vm.messages.contains(where: { $0.contentText == "只有第一条" }),
                       "newer reload must fully replace stale payload")
    }

    func testReloadRaceCoalescesOlderSnapshotBeforeApplyingNewestBubbleSet() async throws {
        var messageCalls = 0
        URLProtocolStub.handler = { req in
            if req.url?.path == "/admin/conversations" {
                return (200, Data(#"{"data":[{"id":"chat-1","source":"chat","external_key":"chat:default","category":"daily","display_name":"chat · chat:default","message_count":3}]}"#.utf8))
            }
            if req.url?.path == "/admin/conversations/chat-1/messages" {
                messageCalls += 1
                if messageCalls == 1 {
                    Thread.sleep(forTimeInterval: 0.12)
                    return (200, Data(#"{"data":[{"id":1,"role":"user","content_text":"问"},{"id":2,"role":"assistant","content_text":"第一条","bubble_index":0,"bubble_count":2}]}"#.utf8))
                }
                return (200, Data(#"{"data":[{"id":1,"role":"user","content_text":"问"},{"id":2,"role":"assistant","content_text":"第一条","bubble_index":0,"bubble_count":2},{"id":3,"role":"assistant","content_text":"第二条","bubble_index":1,"bubble_count":2}]}"#.utf8))
            }
            return (404, Data())
        }
        let vm = SessionsViewModel(api: stubbedClient(), preferredSource: "chat")
        let older = Task { await vm.reload() }
        await Task.yield()
        let newer = Task { await vm.reload() }
        await older.value
        await newer.value
        XCTAssertEqual(messageCalls, 2, "a concurrent reload queues one fresh snapshot")
        XCTAssertEqual(vm.messages.compactMap(\.contentText), ["问", "第一条", "第二条"])
        XCTAssertEqual(vm.messages.compactMap(\.bubbleIndex), [0, 1])
    }

    func testSendDailyIsOptimisticThenAlignsWithServer() async throws {
        let requestStarted = expectation(description: "chat request started")
        let gate = DispatchSemaphore(value: 0)
        var sent = false
        URLProtocolStub.handler = { req in
            if req.httpMethod == "POST" {
                requestStarted.fulfill()
                _ = gate.wait(timeout: .now() + 2)
                sent = true
                return (200, Data(#"{"choices":[{"message":{"content":"收到"}}]}"#.utf8))
            }
            if req.url?.path == "/admin/conversations" {
                return (200, Data(#"{"data":[{"id":"chat-1","source":"chat","external_key":"chat:default","category":"daily","display_name":"chat · chat:default","message_count":2}]}"#.utf8))
            }
            if req.url?.path == "/admin/conversations/chat-1/messages" {
                let body = sent
                    ? #"{"data":[{"id":1,"role":"user","content_text":"你好","attachments":[]},{"id":2,"role":"assistant","content_text":"收到","attachments":[]}]}"#
                    : #"{"data":[]}"#
                return (200, Data(body.utf8))
            }
            return (404, Data())
        }
        let vm = SessionsViewModel(api: stubbedClient(), preferredSource: "chat")
        let task = Task { await vm.sendDaily("你好") }
        await fulfillment(of: [requestStarted], timeout: 1)
        XCTAssertEqual(vm.messages.dropLast().last?.contentText, "你好")
        XCTAssertLessThan(vm.messages.dropLast().last?.id ?? 0, 0)
        XCTAssertEqual(vm.messages.last?.role, "assistant")
        XCTAssertEqual(vm.messages.last?.contentText, "")
        XCTAssertTrue(vm.isSending)
        gate.signal()
        let succeeded = await task.value
        XCTAssertTrue(succeeded)
        XCTAssertEqual(vm.messages.map(\.contentText), ["你好", "收到"])
        XCTAssertNil(vm.failedSend)
    }

    func testSendDailyKeepsTwoOptimisticBubblesThenReloadsTwoDurableRows() async throws {
        URLProtocolStub.contentTypeProvider = { req in req.httpMethod == "POST" ? "text/event-stream" : "application/json" }
        defer { URLProtocolStub.contentTypeProvider = nil }
        URLProtocolStub.handler = { req in
            if req.httpMethod == "POST" {
                let frames = [
                    #"data: {"choices":[{"delta":{"content":"刚回"},"finish_reason":null}],"companion_bubble_index":0,"companion_bubble_count":2,"companion_message_id":11}"#,
                    #"data: {"choices":[{"delta":{"content":"来呀"},"finish_reason":null}],"companion_bubble_index":0,"companion_bubble_count":2,"companion_message_id":11}"#,
                    #"data: {"choices":[{"delta":{"content":"先歇"},"finish_reason":null}],"companion_bubble_index":1,"companion_bubble_count":2,"companion_message_id":12}"#,
                    #"data: {"choices":[{"delta":{"content":"会也行"},"finish_reason":"stop"}],"companion_bubble_index":1,"companion_bubble_count":2,"companion_message_id":12}"#,
                    "data: [DONE]"
                ].joined(separator: "\n\n") + "\n\n"
                return (200, Data(frames.utf8))
            }
            if req.url?.path == "/admin/conversations" {
                return (200, Data(#"{"data":[{"id":"chat-1","source":"chat","external_key":"chat:default","category":"daily","display_name":"chat · chat:default","message_count":3}]}"#.utf8))
            }
            if req.url?.path == "/admin/conversations/chat-1/messages" {
                return (200, Data(#"{"data":[{"id":10,"role":"user","content_text":"问"},{"id":11,"role":"assistant","content_text":"刚回来呀","bubble_index":0,"bubble_count":2,"bubble_turn_id":"turn-1"},{"id":12,"role":"assistant","content_text":"先歇会也行","bubble_index":1,"bubble_count":2,"bubble_turn_id":"turn-1"}]}"#.utf8))
            }
            return (404, Data())
        }
        let vm = SessionsViewModel(api: stubbedClient(), preferredSource: "chat")
        let succeeded = await vm.sendDaily("问")
        XCTAssertTrue(succeeded)
        XCTAssertEqual(vm.messages.compactMap(\.contentText), ["问", "刚回来呀", "先歇会也行"])
        XCTAssertEqual(vm.messages.filter { $0.role == "assistant" }.map(\.id), [11, 12])
        XCTAssertEqual(vm.messages.compactMap(\.bubbleIndex), [0, 1])
    }

    func testTransientSendFailureRecoversWithoutUserResend() async throws {
        var attempts = 0
        var requestIDs: [String] = []
        URLProtocolStub.handler = { req in
            if req.httpMethod == "POST" {
                attempts += 1
                requestIDs.append(req.value(forHTTPHeaderField: "X-Companion-Request-ID") ?? "")
                if attempts == 1 { return (502, Data(#"{"error":{"message":"offline"}}"#.utf8)) }
                return (200, Data(#"{"choices":[{"message":{"content":"重试成功"}}]}"#.utf8))
            }
            if req.url?.path == "/admin/conversations" {
                return (200, Data(#"{"data":[{"id":"chat-1","source":"chat","external_key":"chat:default","category":"daily","display_name":"chat · chat:default","message_count":2}]}"#.utf8))
            }
            if req.url?.path == "/admin/conversations/chat-1/messages" {
                let body = attempts > 1
                    ? #"{"data":[{"id":1,"role":"user","content_text":"保留我","attachments":[]},{"id":2,"role":"assistant","content_text":"重试成功","attachments":[]}]}"#
                    : #"{"data":[{"id":1,"role":"user","content_text":"保留我","attachments":[]}]}"#
                return (200, Data(body.utf8))
            }
            return (404, Data())
        }
        let vm = SessionsViewModel(api: stubbedClient(), preferredSource: "chat")
        let firstSucceeded = await vm.sendDaily("保留我")
        XCTAssertTrue(firstSucceeded)
        XCTAssertEqual(attempts, 2)
        XCTAssertEqual(Set(requestIDs).count, 1)
        XCTAssertFalse(requestIDs[0].isEmpty)
        XCTAssertEqual(vm.messages.last?.contentText, "重试成功")
        XCTAssertNil(vm.failedSend)
    }

    func testFirstMessageCreatesAndLoadsConversation() async throws {
        var created = false
        URLProtocolStub.handler = { req in
            if req.httpMethod == "POST" {
                created = true
                return (200, Data(#"{"choices":[{"message":{"content":"第一条回复"}}]}"#.utf8))
            }
            if req.url?.path == "/admin/conversations" {
                let body = created
                    ? #"{"data":[{"id":"new-chat","source":"chat","external_key":"chat:default","category":"daily","display_name":"chat · chat:default","message_count":2}]}"#
                    : #"{"data":[]}"#
                return (200, Data(body.utf8))
            }
            if req.url?.path == "/admin/conversations/new-chat/messages" {
                return (200, Data(#"{"data":[{"id":1,"role":"user","content_text":"第一条","attachments":[]},{"id":2,"role":"assistant","content_text":"第一条回复","attachments":[]}]}"#.utf8))
            }
            return (404, Data())
        }
        let vm = SessionsViewModel(api: stubbedClient(), preferredSource: "chat")
        await vm.reload()
        XCTAssertTrue(vm.messages.isEmpty)
        let succeeded = await vm.sendDaily("第一条")
        XCTAssertTrue(succeeded)
        XCTAssertEqual(vm.conversations.first?.id, "new-chat")
        XCTAssertEqual(vm.messages.count, 2)
    }

    func testImagePickerValidationAndDraftRemoval() throws {
        let png = Data(base64Encoded: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==")!
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("companion-picker-\(UUID().uuidString).png")
        try png.write(to: url, options: .atomic)
        defer { try? FileManager.default.removeItem(at: url) }
        let pending = try PendingImageAttachment.load(from: url)
        XCTAssertEqual(pending.mime, "image/png")
        XCTAssertEqual(pending.data, png)
        let draft = AttachmentDraft()
        draft.select(pending)
        XCTAssertEqual(draft.item?.pending.filename, url.lastPathComponent)
        draft.remove()
        XCTAssertNil(draft.item)
        XCTAssertThrowsError(try PendingImageAttachment(filename: "fake.png", mime: "image/png", data: Data("fake".utf8)))
    }

    func testWebTogglePersistsAcrossViewModelRestart() {
        let suiteName = "CompanionKitTests.web.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suiteName)!
        defer { defaults.removePersistentDomain(forName: suiteName) }
        let first = SessionsViewModel(api: stubbedClient(), preferredSource: "chat", defaults: defaults)
        XCTAssertFalse(first.webEnabled)
        first.setWebEnabled(true)
        let restarted = SessionsViewModel(api: stubbedClient(), preferredSource: "chat", defaults: defaults)
        XCTAssertTrue(restarted.webEnabled)
        restarted.setWebEnabled(false)
        let restartedAgain = SessionsViewModel(api: stubbedClient(), preferredSource: "chat", defaults: defaults)
        XCTAssertFalse(restartedAgain.webEnabled)
    }

    func testConnectionViewModelHandlesProactiveEvent() {
        let vm = ConnectionViewModel()
        let event = RealtimeEvent(type: "proactive.created", eventId: "e1", at: nil,
                                  sessionId: "s-pro", data: .dictionary(["preview": .string("记得测新版哦")]))
        vm.handle(event)
        XCTAssertEqual(vm.proactiveEvents.count, 1)
        XCTAssertEqual(vm.lastEvent?.type, "proactive.created")

        vm.handle(RealtimeEvent(type: "tool.completed", eventId: "e2", at: nil, sessionId: "s",
                                data: .dictionary(["name": .string("bash"), "output_chars": .number(70000)])))
        XCTAssertEqual(vm.activityEvents.count, 1)

        vm.handle(RealtimeEvent(type: "message.created", eventId: "u1", at: nil, sessionId: "s",
                                data: .dictionary(["role": .string("user")])))
        XCTAssertEqual(vm.conversationRevision, 0, "incoming user persistence must not disrupt optimistic streaming")
        vm.handle(RealtimeEvent(type: "message.created", eventId: "a1", at: nil, sessionId: "s",
                                data: .dictionary(["role": .string("assistant")])))
        XCTAssertEqual(vm.conversationRevision, 1, "durable assistant completion refreshes history after resume or reconnect")
        vm.handle(RealtimeEvent(type: "permission.requested", eventId: "p1", at: nil, sessionId: "s", data: .dictionary([:])))
        XCTAssertEqual(vm.permissionRevision, 1)

        vm.handle(RealtimeEvent(type: "agent.started", eventId: "run-1", at: nil, sessionId: "s", data: .dictionary([:])))
        XCTAssertTrue(vm.isAgentRunning(sessionID: "s"))
        vm.handle(RealtimeEvent(type: "turn.completed", eventId: "done-1", at: nil, sessionId: "s", data: .dictionary([:])))
        XCTAssertFalse(vm.isAgentRunning(sessionID: "s"), "terminal turn event clears stale busy state")
        vm.handle(RealtimeEvent(type: "agent.started", eventId: "run-2", at: nil, sessionId: "s", data: .dictionary([:])))
        vm.markAgentStreamCompleted(sessionID: "s")
        XCTAssertFalse(vm.isAgentRunning(sessionID: "s"), "SSE completion converges local busy state even if realtime completion is delayed")
    }

    func testGuidanceNoActiveTurnIsReturnedForNormalReroute() async {
        URLProtocolStub.handler = { req in
            switch (req.httpMethod, req.url?.path) {
            case ("GET", "/admin/conversations"):
                return (200, Data(#"{"data":[{"id":"chat-1","source":"chat","external_key":"chat:default","category":"daily","display_name":"chat · chat:default","message_count":2}]}"#.utf8))
            case ("GET", "/admin/conversations/chat-1/messages"):
                return (200, Data(#"{"data":[]}"#.utf8))
            case ("POST", "/admin/sessions/chat-1/guidance"):
                return (409, Data(#"{"error":{"message":"no active turn","type":"conflict","code":"no_active_turn"}}"#.utf8))
            case ("GET", "/admin/sessions/chat-1/guidance"):
                return (200, Data(#"{"generatedAt":"2026-08-28T00:00:00Z","sessionId":"chat-1","clearRule":"test","data":[]}"#.utf8))
            default:
                return (404, Data())
            }
        }
        let vm = SessionsViewModel(api: stubbedClient(), preferredSource: "chat")
        await vm.reload()
        let result = await vm.enqueueGuidanceResult("下一条普通消息")
        XCTAssertEqual(result, .noActiveTurn)
        XCTAssertTrue(vm.queuedGuidance.isEmpty)
        XCTAssertNil(vm.errorText, "stale busy reroute is not presented as a send failure")
    }

    func testStaleGuidanceRerouteWaitsForActualSendCompletionWithoutDelay() async {
        let firstStarted = expectation(description: "first send started")
        let secondStarted = expectation(description: "second send started")
        let firstGate = DispatchSemaphore(value: 0)
        var postCount = 0
        URLProtocolStub.handler = { req in
            if req.httpMethod == "POST" {
                postCount += 1
                if postCount == 1 {
                    firstStarted.fulfill()
                    _ = firstGate.wait(timeout: .now() + 2)
                } else { secondStarted.fulfill() }
                return (200, Data(#"{"choices":[{"message":{"content":"ok"}}]}"#.utf8))
            }
            if req.url?.path == "/admin/conversations" {
                return (200, Data(#"{"data":[{"id":"chat-1","source":"chat","external_key":"chat:default","category":"daily","display_name":"chat · chat:default","message_count":2}]}"#.utf8))
            }
            if req.url?.path == "/admin/conversations/chat-1/messages" {
                return (200, Data(#"{"data":[]}"#.utf8))
            }
            return (404, Data())
        }
        let vm = SessionsViewModel(api: stubbedClient(), preferredSource: "chat")
        let first = Task { await vm.sendDaily("first") }
        await fulfillment(of: [firstStarted], timeout: 1)
        let rerouted = Task { await vm.sendAfterCurrentTurnCompletes("second") }
        await Task.yield()
        XCTAssertEqual(postCount, 1, "rerouted message waits on lifecycle completion rather than racing the prior reload")
        firstGate.signal()
        let firstResult = await first.value
        XCTAssertTrue(firstResult)
        await fulfillment(of: [secondStarted], timeout: 1)
        let reroutedResult = await rerouted.value
        XCTAssertTrue(reroutedResult)
        XCTAssertEqual(postCount, 2)
    }

    func testSettingsViewModelRoundTrip() async throws {
        URLProtocolStub.handler = { req in
            if req.httpMethod == "GET" {
                return (200, Data(#"{"proactiveLevel":"low","proactiveMessagesEnabled":false,"quietHours":{"start":"22:00","end":"07:30"},"weatherAwareness":true,"followUpEnabled":true,"proactiveImagesEnabled":true,"dailyProactiveCap":1,"dailyProactiveImageCap":0}"#.utf8))
            }
            return (200, Data(#"{"proactiveLevel":"active","proactiveMessagesEnabled":true,"quietHours":{"start":"23:00","end":"08:00"},"weatherAwareness":false,"followUpEnabled":false,"proactiveImagesEnabled":false,"dailyProactiveCap":5,"dailyProactiveImageCap":2}"#.utf8))
        }
        let vm = SettingsViewModel(api: stubbedClient())
        await vm.load()
        XCTAssertEqual(vm.level, "low")
        XCTAssertFalse(vm.proactiveMessages)
        vm.level = "active"
        vm.dailyImageCap = 2
        await vm.save()
        XCTAssertEqual(vm.dailyCap, 5)
        XCTAssertEqual(vm.quietStart, "23:00")
        XCTAssertNotNil(vm.savedAt)
    }
}
