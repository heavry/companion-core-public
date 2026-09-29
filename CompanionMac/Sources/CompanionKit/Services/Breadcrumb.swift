import Foundation

/// 诊断面包屑：仅在 COMPANION_BREADCRUMBS=1 时输出到 stderr。
/// 只记录事件名 + 时间戳，绝不记录 API key / Persona / 消息内容。
public enum Breadcrumb {
    static let enabled = ProcessInfo.processInfo.environment["COMPANION_BREADCRUMBS"] == "1"
    public static func emit(_ event: String) {
        guard enabled else { return }
        let line = "[bc] \(Int(Date().timeIntervalSince1970 * 1000)) \(event)\n"
        FileHandle.standardError.write(Data(line.utf8))
    }
}
