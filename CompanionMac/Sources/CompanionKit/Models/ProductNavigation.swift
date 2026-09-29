import Foundation

public enum ProductDestination: String, CaseIterable, Codable, Sendable {
    case chat
    case today
    case relationship
    case plans
    case capabilities
    case memory
    case usage
    case settings

    public static func normalized(_ storedValue: String) -> ProductDestination {
        switch storedValue {
        case "timeline": return .today
        case "agents", "modules": return .capabilities
        default: return ProductDestination(rawValue: storedValue) ?? .chat
        }
    }
}
