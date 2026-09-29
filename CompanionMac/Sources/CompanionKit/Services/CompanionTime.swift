import Foundation

public enum CompanionTime {
    public static let timeZoneIdentifier = "Asia/Shanghai"
    public static let timeZone = TimeZone(identifier: timeZoneIdentifier)!
    public static let timeZoneDisplay = "北京时间 · Asia/Shanghai · UTC+8"
    public static let minuteRefreshInterval: TimeInterval = 60

    public static var calendar: Calendar {
        var value = Calendar(identifier: .gregorian)
        value.locale = Locale(identifier: "zh_CN")
        value.timeZone = timeZone
        return value
    }

    public static func date(fromISO8601 raw: String) -> Date? {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let value = formatter.date(from: raw) { return value }
        formatter.formatOptions = [.withInternetDateTime]
        return formatter.date(from: raw)
    }

    public static func string(_ date: Date, format: String) -> String {
        let formatter = DateFormatter()
        formatter.calendar = calendar
        formatter.timeZone = timeZone
        formatter.locale = Locale(identifier: "zh_CN")
        formatter.dateFormat = format
        return formatter.string(from: date)
    }

    public static func shortTime(_ date: Date) -> String { string(date, format: "HH:mm") }
    public static func shortTime(fromISO8601 raw: String) -> String {
        guard let date = date(fromISO8601: raw) else { return String(raw.prefix(16)).replacingOccurrences(of: "T", with: " ") }
        return shortTime(date)
    }
    public static func dayLabel(_ date: Date) -> String { string(date, format: "M月d日") }
    public static func dateTime(_ date: Date) -> String { string(date, format: "M月d日 HH:mm") }
    public static func dateTime(fromISO8601 raw: String) -> String {
        guard let date = date(fromISO8601: raw) else { return String(raw.prefix(16)).replacingOccurrences(of: "T", with: " ") }
        return dateTime(date)
    }
    public static func naturalDateTime(fromISO8601 raw: String, relativeTo now: Date = Date()) -> String {
        guard let date = date(fromISO8601: raw) else { return String(raw.prefix(16)).replacingOccurrences(of: "T", with: " ") }
        let cal = calendar
        if cal.isDate(date, inSameDayAs: now) { return "今天 \(shortTime(date))" }
        if let yesterday = cal.date(byAdding: .day, value: -1, to: now), cal.isDate(date, inSameDayAs: yesterday) { return "昨天 \(shortTime(date))" }
        if let tomorrow = cal.date(byAdding: .day, value: 1, to: now), cal.isDate(date, inSameDayAs: tomorrow) { return "明天 \(shortTime(date))" }
        return dateTime(date)
    }
    public static func todayHeader(_ date: Date = Date()) -> String { string(date, format: "M月d日 EEEE HH:mm") }
    public static func greeting(_ date: Date = Date()) -> String {
        switch calendar.component(.hour, from: date) {
        case 5..<12: return "早上好"
        case 12..<18: return "下午好"
        default: return "晚上好"
        }
    }
}

extension String {
    public static func dateFromISO8601(_ raw: String) -> Date? { CompanionTime.date(fromISO8601: raw) }
}
