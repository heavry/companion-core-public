import XCTest
@testable import CompanionKit

final class CompanionTimeTests: XCTestCase {
    private let boundary = "2026-08-28T16:30:00Z"

    func testUTCBoundaryDisplaysAsNextBeijingDay() throws {
        let date = try XCTUnwrap(CompanionTime.date(fromISO8601: boundary))
        XCTAssertEqual(CompanionTime.shortTime(date), "00:30")
        XCTAssertEqual(CompanionTime.dayLabel(date), "8月29日")
        XCTAssertEqual(CompanionTime.dateTime(date), "8月29日 00:30")
        XCTAssertEqual(String.localTime(from: boundary), "00:30")
    }

    func testChatTodayPlansUsageAndMemoryUseSameAuthoritativeFormatter() throws {
        let now = try XCTUnwrap(CompanionTime.date(fromISO8601: "2026-08-28T17:00:00Z"))
        XCTAssertEqual(CompanionTime.naturalDateTime(fromISO8601: boundary, relativeTo: now), "今天 00:30")
        XCTAssertEqual(CompanionTime.naturalDateTime(fromISO8601: "2026-08-27T16:30:00Z", relativeTo: now), "昨天 00:30")
        XCTAssertEqual(CompanionTime.naturalDateTime(fromISO8601: "2026-08-26T12:14:00Z", relativeTo: now), "8月26日 20:14")
    }

    func testPlanCalendarKeepsBeijingWallClockIndependentOfSystemZone() throws {
        let instant = try XCTUnwrap(CompanionTime.date(fromISO8601: "2026-08-28T13:00:00Z"))
        XCTAssertEqual(CompanionTime.calendar.component(.hour, from: instant), 21)
        XCTAssertEqual(CompanionTime.calendar.component(.day, from: instant), 28)
        XCTAssertEqual(CompanionTime.timeZone.identifier, "Asia/Shanghai")
    }

    func testTodayHeaderGreetingSettingsAndMinuteRefresh() throws {
        let evening = try XCTUnwrap(CompanionTime.date(fromISO8601: "2026-08-28T12:00:00Z"))
        XCTAssertTrue(CompanionTime.todayHeader(evening).contains("20:00"))
        XCTAssertEqual(CompanionTime.greeting(evening), "晚上好")
        XCTAssertEqual(CompanionTime.timeZoneDisplay, "北京时间 · Asia/Shanghai · UTC+8")
        XCTAssertEqual(CompanionTime.minuteRefreshInterval, 60)
    }
}
