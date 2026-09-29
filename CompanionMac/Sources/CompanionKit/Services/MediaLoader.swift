import AppKit

/// 带鉴权的媒体加载与内存缓存（MainActor 隔离）。
@MainActor
public final class MediaLoader {
    public static let shared = MediaLoader()
    private var cache: [String: NSImage] = [:]
    public var apiProvider: (() -> APIClient?)?

    public init() {}

    public func loadAsync(mediaId: String) async -> NSImage? {
        if let cached = cache[mediaId] { return cached }
        guard let api = apiProvider?() else { return nil }
        guard let (data, _) = try? await api.mediaData(id: mediaId), let img = NSImage(data: data) else { return nil }
        cache[mediaId] = img
        return img
    }
}
