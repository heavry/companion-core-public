import Foundation

/// 明确编码 Desktop 启动依赖：Core 先启动，凭据随后恢复。即使凭据不可用，
/// `coreReady` 仍保留真实结果，不把局部安全存储错误放大成整个 App 不可用。
public enum CoreFirstStartupSequence {
    public struct Result<Credential> {
        public let coreReady: Bool
        public let credential: Credential
    }

    public static func run<Credential>(
        startCore: () async -> Bool,
        restoreCredential: () async -> Credential
    ) async -> Result<Credential> {
        let coreReady = await startCore()
        let credential = await restoreCredential()
        return Result(coreReady: coreReady, credential: credential)
    }
}
