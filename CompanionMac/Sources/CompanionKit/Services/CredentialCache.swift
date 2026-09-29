import Foundation
import os

/// 已解锁凭据的进程内缓存。Keychain 只在显式恢复/保存时访问；普通 API 与
/// WebSocket 请求只读此缓存，避免反复触发系统授权或阻塞调用线程。
public final class CredentialCache: Sendable {
    public static let shared = CredentialCache()

    private let storage: OSAllocatedUnfairLock<String>

    public init(initialValue: String = "") {
        storage = OSAllocatedUnfairLock(initialState: initialValue)
    }

    public var value: String {
        storage.withLock { $0 }
    }

    public var isConfigured: Bool {
        !value.isEmpty
    }

    public func replace(with value: String?) {
        storage.withLock { $0 = value ?? "" }
    }
}
