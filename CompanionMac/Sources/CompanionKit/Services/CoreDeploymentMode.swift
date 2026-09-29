import Foundation

public enum CoreDeploymentMode: String, CaseIterable, Sendable {
    case local
    case remote

    public static func resolve(environment: String?, stored: String?) -> CoreDeploymentMode {
        if let environment, let value = CoreDeploymentMode(rawValue: environment.lowercased()) { return value }
        if let stored, let value = CoreDeploymentMode(rawValue: stored.lowercased()) { return value }
        return .local
    }

    public func validate(baseURL: URL) -> String? {
        let host = baseURL.host?.lowercased() ?? ""
        let isLoopback = ["127.0.0.1", "localhost", "::1"].contains(host)
        switch self {
        case .local:
            guard isLoopback, baseURL.port == 8770 else {
                return "CORE_MODE=local 只允许连接本机 127.0.0.1:8770。"
            }
        case .remote:
            guard !isLoopback, baseURL.scheme?.lowercased() == "https" else {
                return "CORE_MODE=remote 必须配置非回环 HTTPS Core URL。"
            }
        }
        return nil
    }
}
