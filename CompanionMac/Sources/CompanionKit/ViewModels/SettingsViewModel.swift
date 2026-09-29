import Foundation

/// Settings 页面视图模型：Behavior Settings + Persona 只读摘要。
@MainActor
public final class SettingsViewModel: ObservableObject {
    @Published public var level: String
    @Published public var quietStart: String
    @Published public var quietEnd: String
    @Published public var proactiveMessages: Bool
    @Published public var weatherAwareness: Bool
    @Published public var followUp: Bool
    @Published public var proactiveImages: Bool
    @Published public var dailyCap: Int
    @Published public var dailyImageCap: Int
    @Published public private(set) var savedAt: Date?
    @Published public var errorText: String?

    private let api: APIClient

    public init(api: APIClient) {
        self.api = api
        self.level = "normal"
        self.quietStart = "23:00"
        self.quietEnd = "08:00"
        self.proactiveMessages = true
        self.weatherAwareness = true
        self.followUp = true
        self.proactiveImages = true
        self.dailyCap = 3
        self.dailyImageCap = 1
    }

    public func load() async {
        do { apply(try await api.behavior()) }
        catch { errorText = String(describing: error) }
    }

    public func apply(_ s: BehaviorSettings) {
        level = s.proactiveLevel
        quietStart = s.quietHours.start
        quietEnd = s.quietHours.end
        proactiveMessages = s.proactiveMessagesEnabled
        weatherAwareness = s.weatherAwareness
        followUp = s.followUpEnabled
        proactiveImages = s.proactiveImagesEnabled
        dailyCap = s.dailyProactiveCap
        dailyImageCap = s.dailyProactiveImageCap
    }

    public func currentSettings() -> BehaviorSettings {
        BehaviorSettings(
            proactiveLevel: level,
            proactiveMessagesEnabled: proactiveMessages,
            quietHours: QuietHours(start: quietStart, end: quietEnd),
            weatherAwareness: weatherAwareness,
            followUpEnabled: followUp,
            proactiveImagesEnabled: proactiveImages,
            dailyProactiveCap: dailyCap,
            dailyProactiveImageCap: dailyImageCap
        )
    }

    public func save() async {
        do {
            let saved = try await api.updateBehavior(currentSettings())
            apply(saved)
            savedAt = Date()
        } catch {
            errorText = String(describing: error)
        }
    }
}
