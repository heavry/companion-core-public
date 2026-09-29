import XCTest
@testable import CompanionKit

final class ProductNavigationTests: XCTestCase {
    func testProductNavigationOrderAndLegacyMigration() {
        XCTAssertEqual(ProductDestination.allCases.map(\.rawValue), [
            "chat", "today", "relationship", "plans", "capabilities", "memory", "usage", "settings"
        ])
        XCTAssertEqual(ProductDestination.normalized("timeline"), .today)
        XCTAssertEqual(ProductDestination.normalized("agents"), .capabilities)
        XCTAssertEqual(ProductDestination.normalized("modules"), .capabilities)
        XCTAssertEqual(ProductDestination.normalized("unknown"), .chat)
    }
}

@MainActor
final class MemoryBrainProductTests: XCTestCase {
    private func stubbedClient() -> APIClient {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [URLProtocolStub.self]
        return APIClient(
            config: .init(baseURL: URL(string: "http://127.0.0.1:8770")!, tokenProvider: { "test" }),
            session: URLSession(configuration: config)
        )
    }

    func testBrainLoadsRealNodesWithoutInventingRelations() async {
        URLProtocolStub.handler = { request in
            XCTAssertEqual(request.url?.path, "/admin/memory/brain")
            return (200, Data(Self.brainJSON.utf8))
        }
        let model = MemoryBrainViewModel(api: stubbedClient())
        await model.load()
        XCTAssertEqual(model.snapshot?.nodes.count, 3)
        XCTAssertEqual(model.snapshot?.edges, [])
        XCTAssertEqual(model.selectedNode?.id, "m1")
        XCTAssertEqual(model.relatedNodes, [])
        XCTAssertFalse(model.snapshot?.disclosure.inferredEdges ?? true)
        XCTAssertEqual(model.selectedNode?.visualTier, "major")
        XCTAssertEqual(model.selectedNode?.visualFamily, "preference")
        let firstLayout = MemoryBrainLayout.positions(nodes: model.visibleNodes, in: .init(width: 900, height: 620))
        let secondLayout = MemoryBrainLayout.positions(nodes: model.visibleNodes, in: .init(width: 900, height: 620))
        XCTAssertEqual(firstLayout, secondLayout)
        XCTAssertEqual(MemoryBrainLayout.diameter(for: "major"), 88)
    }

    func testBrainLayoutStaysDeterministicAcrossSparseAndDenseDatasets() throws {
        for count in [3, 8, 20, 100] {
            let nodes = try Self.layoutNodes(count: count)
            let first = MemoryBrainLayout.positions(nodes: nodes, in: .init(width: 1_120, height: 720))
            let second = MemoryBrainLayout.positions(nodes: nodes, in: .init(width: 1_120, height: 720))
            XCTAssertEqual(first.count, count)
            XCTAssertEqual(first, second, "layout must not jump between renders for \(count) nodes")
            XCTAssertTrue(first.values.allSatisfy { point in
                point.x.isFinite && point.y.isFinite && point.x >= 0 && point.x <= 1_120 && point.y >= 0 && point.y <= 720
            })
        }
    }

    func testSearchUsesServerRetrievalKeepsGraphAndFocusesFirstResult() async {
        URLProtocolStub.handler = { request in
            if request.url?.path == "/admin/memory/brain" {
                XCTAssertEqual(URLComponents(url: request.url!, resolvingAgainstBaseURL: false)?.queryItems?.first(where: { $0.name == "search" })?.value, "乌龙茶")
                return (200, Data(Self.searchBrainJSON.utf8))
            }
            XCTAssertEqual(request.url?.path, "/admin/memories/retrieval-debug")
            return (200, Data(#"{"query":"乌龙茶","data":[{"id":"m1","content":"用户喜欢乌龙茶","type":"preference","source":"manual","final_score":3.2,"in_context":true,"reasons":["FTS5 match"]}]}"#.utf8))
        }
        let model = MemoryBrainViewModel(api: stubbedClient())
        model.query = "乌龙茶"
        await model.search()
        XCTAssertEqual(model.visibleNodes.count, 3, "search keeps the whole graph")
        XCTAssertEqual(model.searchResultIDs, ["m1"])
        XCTAssertEqual(model.selectedID, "m1")
        XCTAssertEqual(model.focusID, "m1")
        XCTAssertEqual(model.recallRows.first?.reasons, ["FTS5 match"])
    }

    func testManualMemoryPrepareCreateAndManagementUseMemoryAPI() async {
        var calls: [(String?, String?)] = []
        URLProtocolStub.handler = { request in
            calls.append((request.httpMethod, request.url?.path))
            switch (request.httpMethod, request.url?.path) {
            case ("POST", "/admin/memories/prepare"):
                return (200, Data(#"{"disposition":"ready","reason":null,"duplicate":null,"possibleConflicts":[]}"#.utf8))
            case ("POST", "/admin/memories"):
                let object = try? JSONSerialization.jsonObject(with: request.httpBody ?? Data()) as? [String: Any]
                XCTAssertEqual(object?["mode"] as? String, "manual")
                XCTAssertEqual(object?["temporal_state"] as? String, "planned")
                return (200, Data(#"{"ok":true,"created":true,"outcome":"created","memory":{"id":"m4","content":"长期学习 SwiftUI","type":"project","status":"active","source":"manual","temporal_state":"planned","evidence_mode":"manual"}}"#.utf8))
            case ("GET", "/admin/memory/brain"):
                return (200, Data(Self.brainJSON.utf8))
            case ("PATCH", "/admin/memories/m1"):
                return (200, Data(#"{"ok":true}"#.utf8))
            case ("DELETE", "/admin/memories/m1"):
                return (200, Data(#"{"ok":true}"#.utf8))
            default: return (404, Data())
            }
        }
        let model = MemoryBrainViewModel(api: stubbedClient())
        let draft = ManualMemoryDraft(content: "长期学习 SwiftUI", type: "project", temporalState: "planned", importance: 0.8)
        let assessment = await model.prepareManual(draft)
        XCTAssertEqual(assessment?.disposition, "ready")
        let didCreate = await model.createManual(draft)
        XCTAssertTrue(didCreate)
        XCTAssertEqual(model.focusID, "m4")
        model.selectedID = "m1"
        let didUpdate = await model.updateSelected(content: "更新后的偏好", type: "preference", temporalState: "current")
        XCTAssertTrue(didUpdate)
        model.selectedID = "m1"
        let didRetire = await model.setSelectedStatus("retired")
        XCTAssertTrue(didRetire)
        model.selectedID = "m1"
        let didDelete = await model.deleteSelected()
        XCTAssertTrue(didDelete)
        XCTAssertTrue(calls.contains { $0 == ("POST", "/admin/memories/prepare") })
        XCTAssertTrue(calls.contains { $0 == ("DELETE", "/admin/memories/m1") })
    }

    func testRecallPreviewUsesServerSideEndpointAndPreservesScores() async {
        URLProtocolStub.handler = { request in
            XCTAssertEqual(request.httpMethod, "POST")
            XCTAssertEqual(request.url?.path, "/admin/memories/retrieval-debug")
            return (200, Data(#"{"query":"喝什么","data":[{"id":"m1","content":"用户喜欢乌龙茶","type":"preference","source":"manual","final_score":0.91,"in_context":true,"reasons":["lexical"]}]}"#.utf8))
        }
        let model = MemoryBrainViewModel(api: stubbedClient())
        model.query = "喝什么"
        await model.previewRecall()
        XCTAssertEqual(model.recallRows.map(\.id), ["m1"])
        XCTAssertEqual(model.recallRows.first?.finalScore, 0.91)
        XCTAssertEqual(model.recallRows.first?.reasons, ["lexical"])
    }

    private static let brainJSON = #"""
    {"engine":"legacy-adapter","nodes":[
      {"id":"m1","title":"用户喜欢乌龙茶","content":"用户喜欢乌龙茶","preview":"用户喜欢乌龙茶","kind":"preference","stateFamily":"preference","representationLayer":"reported","temporalState":"current","evidenceMode":"manual","source":"manual","status":"active","importance":0.9,"pinned":false,"createdAt":"2026-08-27T08:00:00Z","updatedAt":"2026-08-27T08:00:00Z","visualTier":"major","visualFamily":"preference","layout":{"angle":0.2,"radius":0.25,"depth":0.8},"evidence":[{"source":"manual","mode":"manual","recordedAt":"2026-08-27T08:00:00Z"}],"relatedMemoryIds":[]},
      {"id":"m2","title":"第二条","content":"第二条真实记忆","preview":"第二条真实记忆","kind":"fact","stateFamily":"not_applicable","representationLayer":"reported","temporalState":"current","evidenceMode":"derived","source":"conversation","status":"active","importance":0.6,"pinned":false,"createdAt":null,"updatedAt":null,"visualTier":"state","visualFamily":"knowledge","layout":{"angle":2.3,"radius":0.55,"depth":0.5},"evidence":[],"relatedMemoryIds":[]},
      {"id":"m3","title":"旧记录","content":"historical note","preview":"historical note","kind":"fact","stateFamily":"not_applicable","representationLayer":"reported","temporalState":"historical","evidenceMode":"derived","source":"legacy","status":"retired","importance":0.2,"pinned":false,"createdAt":null,"updatedAt":null,"visualTier":"minor","visualFamily":"knowledge","layout":{"angle":4.5,"radius":0.8,"depth":0.4},"evidence":[],"relatedMemoryIds":[]}
    ],"edges":[],"search":{"query":"","resultIds":[]},"disclosure":{"inferredEdges":false,"note":"No synthetic edges."}}
    """#
    private static let searchBrainJSON = brainJSON.replacingOccurrences(of: #""search":{"query":"","resultIds":[]}"#, with: #""search":{"query":"乌龙茶","resultIds":["m1"]}"#)

    private static func layoutNodes(count: Int) throws -> [MemoryBrainResponse.Node] {
        let nodes: [[String: Any]] = (0..<count).map { index in
            let tier = index == 0 ? "major" : index < max(2, count / 4) ? "state" : "minor"
            return [
                "id": "layout-\(index)", "title": "Memory \(index)", "content": "Memory \(index)",
                "preview": "Memory \(index)", "kind": index % 2 == 0 ? "fact" : "preference",
                "stateFamily": "not_applicable", "representationLayer": "reported",
                "temporalState": "current", "evidenceMode": "derived", "source": "test",
                "status": "active", "importance": 0.5, "pinned": index == 0,
                "visualTier": tier, "visualFamily": index % 2 == 0 ? "knowledge" : "preference",
                "layout": [
                    "angle": Double(index) / Double(max(1, count)) * Double.pi * 2,
                    "radius": tier == "major" ? 0.25 : tier == "state" ? 0.55 : 0.82,
                    "depth": Double(index % 9) / 8.0
                ],
                "evidence": [], "relatedMemoryIds": []
            ]
        }
        let data = try JSONSerialization.data(withJSONObject: [
            "engine": "legacy-adapter", "nodes": nodes, "edges": [],
            "search": ["query": "", "resultIds": []],
            "disclosure": ["inferredEdges": false, "note": "No synthetic edges."]
        ])
        return try JSONDecoder().decode(MemoryBrainResponse.self, from: data).nodes
    }
}

final class ProductSurfaceDecodingTests: XCTestCase {
    private func stubbedClient() -> APIClient {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [URLProtocolStub.self]
        return APIClient(
            config: .init(baseURL: URL(string: "http://127.0.0.1:8770")!, tokenProvider: { "test" }),
            session: URLSession(configuration: config)
        )
    }

    func testTodayKeepsUnknownUsageUnknownAndDoesNotRequirePlans() async throws {
        URLProtocolStub.handler = { request in
            XCTAssertEqual(request.url?.path, "/admin/product/today")
            return (200, Data(#"{"generatedAt":"2026-08-27T08:00:00Z","events":[],"plans":{"available":false,"upcoming":[]},"proactive":{"allowed":false,"reasons":["quiet_hours"],"level":"normal","messagesToday":0,"dailyCap":3,"pendingFollowups":0,"lastProactiveAt":null,"quietHoursNow":true},"usage":{"requests":1,"inputTokens":null,"outputTokens":null,"cachedTokens":null,"totalTokens":null,"unknownTokenRequests":1},"recentAgentActivity":[]}"#.utf8))
        }
        let value = try await stubbedClient().todaySnapshot()
        XCTAssertNil(value.usage.totalTokens)
        XCTAssertEqual(value.usage.unknownTokenRequests, 1)
        XCTAssertFalse(value.plans.available)
        XCTAssertNil(value.diary)
    }

    func testTodayDecodesDiaryWithoutReplacingExistingSurfaces() async throws {
        URLProtocolStub.handler = { request in
            XCTAssertEqual(request.url?.path, "/admin/product/today")
            return (200, Data(#"{"generatedAt":"2026-09-13T08:00:00Z","events":[],"plans":{"available":true,"upcoming":[]},"proactive":{"allowed":true,"reasons":[],"level":"normal","messagesToday":0,"dailyCap":3,"pendingFollowups":0,"lastProactiveAt":null,"quietHoursNow":false},"usage":{"requests":0,"inputTokens":0,"outputTokens":0,"cachedTokens":0,"totalTokens":0,"unknownTokenRequests":0},"recentAgentActivity":[],"diary":{"available":true,"selectedDate":"2026-09-12","entry":{"dateLocal":"2026-09-12","body":"今天挺安静。","summary":"安静","reflection":"","messageToUser":"你没来的话我就先写在这里了。","createdAt":"2026-09-12T15:30:00Z","userMessageCount":0,"assistantMessageCount":0},"recent":[{"dateLocal":"2026-09-12","summary":"安静","createdAt":"2026-09-12T15:30:00Z","userMessageCount":0}],"previousDate":null,"nextDate":null}}"#.utf8))
        }
        let value = try await stubbedClient().todaySnapshot()
        XCTAssertEqual(value.diary?.selectedDate, "2026-09-12")
        XCTAssertEqual(value.diary?.entry?.body, "今天挺安静。")
        XCTAssertTrue(value.plans.available)
    }

    func testRelationshipDecodesPersonaAndHonestJournalPlaceholder() async throws {
        URLProtocolStub.handler = { request in
            XCTAssertEqual(request.url?.path, "/admin/product/relationship")
            return (200, Data(#"{"generatedAt":"2026-08-27T08:00:00Z","persona":{"id":"yuna","name":"Yuna","coreIdentity":"Companion","personality":["warm"],"speakingStyle":{"tone":"natural","verbosity":"brief","emojiFrequency":"low","rules":[]},"memoryEnabled":true},"memoryOverview":{"total":3,"active":3,"staging":0,"historical":0,"types":{"preference":1},"recent":[]},"contextSummary":null,"contextUpdatedAt":null,"importantEvents":[],"journal":{"available":false,"entries":[]}}"#.utf8))
        }
        let value = try await stubbedClient().relationshipSnapshot()
        XCTAssertEqual(value.persona?.id, "yuna")
        XCTAssertEqual(value.memoryOverview.active, 3)
        XCTAssertFalse(value.journal.available)
    }

    func testSchedulerSnapshotAndMutationsUseStableAdminAPI() async throws {
        let planJSON = #"{"id":"p1","title":"喝水","schedule":{"type":"cron","at":null,"expression":"0 9 * * *","timeZone":"Asia/Shanghai"},"target":{"type":"conversation","operation":null,"content":"记得喝水","importance":null},"enabled":true,"nextRunAt":"2026-08-28T01:00:00Z","lastRunAt":null,"createdAt":"2026-08-27T08:00:00Z","updatedAt":"2026-08-27T08:00:00Z"}"#
        URLProtocolStub.handler = { request in
            switch (request.httpMethod, request.url?.path) {
            case ("GET", "/admin/scheduler"):
                return (200, Data("{\"generatedAt\":\"2026-08-27T08:00:00Z\",\"plans\":[\(planJSON)],\"history\":[]}".utf8))
            case ("POST", "/admin/scheduler"), ("PATCH", "/admin/scheduler/p1"):
                XCTAssertNotNil(request.httpBody)
                return (200, Data("{\"ok\":true,\"plan\":\(planJSON)}".utf8))
            case ("DELETE", "/admin/scheduler/p1"):
                let object = try? JSONSerialization.jsonObject(with: request.httpBody ?? Data()) as? [String: Bool]
                XCTAssertEqual(object?["confirm"], true)
                return (200, Data(#"{"ok":true}"#.utf8))
            default: return (404, Data())
            }
        }
        let client = stubbedClient(), snapshot = try await client.schedulerSnapshot()
        XCTAssertEqual(snapshot.plans.map(\.id), ["p1"])
        let draft = SchedulerPlanDraft(title: "喝水", schedule: .init(type: "cron", expression: "0 9 * * *", timeZone: "Asia/Shanghai"), target: .init(type: "conversation", content: "记得喝水"))
        let created = try await client.createPlan(draft)
        XCTAssertEqual(created.id, "p1")
        let disabled = try await client.setPlanEnabled(id: "p1", enabled: false)
        XCTAssertEqual(disabled.id, "p1")
        try await client.deletePlan(id: "p1")
    }

    func testCapabilityProductUsesRegistryProjection() async throws {
        URLProtocolStub.handler = { request in
            XCTAssertEqual(request.url?.path, "/admin/product/capabilities")
            return (200, Data(#"{"generatedAt":"2026-08-27T08:00:00Z","source":"companion-capability-registry","data":[{"id":"mcp:pw:browser_click","name":"Browser click","wireName":"mcp_pw_browser_click","description":"Click an element","category":"Action","enabled":true,"configured":true,"scope":["Agent"],"provider":"pw","permission":["write"],"riskLevel":"medium","health":"connected","lastStatus":null,"requiresApproval":false}]}"#.utf8))
        }
        let value = try await stubbedClient().capabilityProductSnapshot()
        XCTAssertEqual(value.source, "companion-capability-registry")
        XCTAssertEqual(value.data.first?.provider, "pw")
        XCTAssertEqual(value.data.first?.category, "Action")
    }

    func testGuidanceQueueAPIKeepsFIFOStatusAndCancelsByID() async throws {
        var calls: [(String?, String?)] = []
        URLProtocolStub.handler = { request in
            calls.append((request.httpMethod, request.url?.path))
            switch request.httpMethod {
            case "GET":
                return (200, Data(#"{"generatedAt":"2026-08-27T08:00:00Z","sessionId":"s1","clearRule":"pending remains queued","data":[{"id":"q1","sessionId":"s1","content":"do not touch it","status":"queued","sequence":1,"createdAt":"2026-08-27T08:00:00Z","consumedAt":null,"cancelledAt":null}]}"#.utf8))
            case "POST":
                return (201, Data(#"{"ok":true,"item":{"id":"q2","sessionId":"s1","content":"second","status":"queued","sequence":2,"createdAt":"2026-08-27T08:00:01Z","consumedAt":null,"cancelledAt":null}}"#.utf8))
            case "DELETE": return (200, Data(#"{"ok":true}"#.utf8))
            default: return (404, Data())
            }
        }
        let client = stubbedClient(), snapshot = try await client.guidanceQueue(sessionID: "s1")
        XCTAssertEqual(snapshot.data.map(\.id), ["q1"])
        let queued = try await client.enqueueGuidance(sessionID: "s1", content: "second")
        XCTAssertEqual(queued.id, "q2")
        try await client.cancelGuidance(sessionID: "s1", queueID: "q1")
        XCTAssertEqual(calls.map { $0.0 }, ["GET", "POST", "DELETE"])
    }
}
