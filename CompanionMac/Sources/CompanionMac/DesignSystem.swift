import SwiftUI
import AppKit

// MARK: - Companion Design System

/// Companion 的视觉语言唯一来源。颜色全部使用系统语义色或动态 Light / Dark 色，
/// 页面只组合 token 和下方组件，不再各自发明材质、阴影与状态样式。
public enum DS {
    /// 4 / 8 / 12 / 16 / 20 / 24 / 32 / 48
    public enum Space {
        public static let xs: CGFloat = 4
        public static let s: CGFloat = 8
        public static let m: CGFloat = 12
        public static let l: CGFloat = 16
        public static let xl20: CGFloat = 20
        public static let xl: CGFloat = 24
        public static let xxl: CGFloat = 32
        public static let xxxl: CGFloat = 48
    }

    public enum Radius {
        public static let xs: CGFloat = 8
        public static let s: CGFloat = 10
        public static let m: CGFloat = 14
        public static let l: CGFloat = 18
        public static let xl: CGFloat = 24
        public static let xxl: CGFloat = 30
    }

    public enum Surface {
        public static let chrome: Material = .ultraThinMaterial
        public static let quietGlass: Material = .ultraThinMaterial
        public static let glass: Material = .thinMaterial
        public static let elevatedGlass: Material = .regularMaterial
    }

    public enum Motion {
        public enum Pace { case fast, normal, slow }
        public static let fast: Animation = .easeOut(duration: 0.12)
        public static let normal: Animation = .easeInOut(duration: 0.18)
        public static let slow: Animation = .easeInOut(duration: 0.24)
        public static let gentleSpring: Animation = .spring(response: 0.30, dampingFraction: 0.86)

        /// 所有新增动效通过这里尊重 macOS Reduce Motion。
        public static func animation(_ pace: Pace = .normal, reduceMotion: Bool) -> Animation? {
            guard !reduceMotion else { return nil }
            switch pace {
            case .fast: return fast
            case .normal: return normal
            case .slow: return slow
            }
        }
    }

    public enum ColorToken {
        private static func adaptive(light: NSColor, dark: NSColor) -> Color {
            let color = NSColor(name: nil) { appearance in
                appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua ? dark : light
            }
            return Color(nsColor: color)
        }

        public static var windowBackground: Color {
            adaptive(
                light: NSColor(calibratedRed: 0.965, green: 0.958, blue: 0.948, alpha: 1),
                dark: NSColor(calibratedRed: 0.075, green: 0.075, blue: 0.088, alpha: 1)
            )
        }
        public static var sidebar: Color {
            adaptive(
                light: NSColor(calibratedRed: 0.935, green: 0.925, blue: 0.915, alpha: 0.86),
                dark: NSColor(calibratedRed: 0.105, green: 0.102, blue: 0.120, alpha: 0.88)
            )
        }
        public static var surface: Color { Color(nsColor: .controlBackgroundColor) }
        public static var surfaceSecondary: Color {
            adaptive(light: NSColor(calibratedWhite: 1, alpha: 0.58),
                     dark: NSColor(calibratedWhite: 0.19, alpha: 0.58))
        }
        public static var surfaceElevated: Color {
            adaptive(light: NSColor(calibratedWhite: 1, alpha: 0.84),
                     dark: NSColor(calibratedWhite: 0.16, alpha: 0.84))
        }
        public static var inspector: Color {
            adaptive(
                light: NSColor(calibratedRed: 0.975, green: 0.970, blue: 0.963, alpha: 0.82),
                dark: NSColor(calibratedRed: 0.125, green: 0.122, blue: 0.142, alpha: 0.86)
            )
        }
        public static var separator: Color { Color(nsColor: .separatorColor).opacity(0.62) }
        public static var glassBorder: Color {
            adaptive(light: NSColor(calibratedWhite: 0.18, alpha: 0.10),
                     dark: NSColor(calibratedWhite: 1, alpha: 0.13))
        }
        public static var textPrimary: Color { Color(nsColor: .labelColor) }
        public static var textSecondary: Color { Color(nsColor: .secondaryLabelColor) }
        public static var textTertiary: Color { Color(nsColor: .tertiaryLabelColor) }
        public static var accent: Color { .accentColor }
        public static var accentSoft: Color { Color.accentColor.opacity(0.13) }
        public static var selectionFill: Color { Color.accentColor.opacity(0.14) }
        public static var focusRing: Color { Color.accentColor.opacity(0.58) }
        public static var bubbleUser: Color { Color.accentColor.opacity(0.16) }
        public static var bubbleCompanion: Color { surfaceElevated }
        public static var success: Color { Color(nsColor: .systemGreen) }
        public static var warning: Color { Color(nsColor: .systemOrange) }
        public static var danger: Color { Color(nsColor: .systemRed) }
        public static var info: Color { Color(nsColor: .systemBlue) }
    }

    public enum Typography {
        public static var hero: Font { .system(size: 34, weight: .semibold, design: .rounded) }
        public static var pageTitle: Font { .system(size: 22, weight: .semibold, design: .rounded) }
        public static var section: Font { .system(size: 15, weight: .semibold) }
        public static var metric: Font { .system(size: 30, weight: .semibold, design: .rounded) }
        public static var body: Font { .body }
        public static var secondary: Font { .callout }
        public static var caption: Font { .caption }
        public static var eyebrow: Font { .system(size: 10, weight: .semibold).smallCaps() }
        public static var mono: Font { .system(.caption, design: .monospaced) }
    }

    public enum Shadow {
        public struct Style {
            public let color: Color
            public let radius: CGFloat
            public let x: CGFloat
            public let y: CGFloat
            public init(color: Color, radius: CGFloat, x: CGFloat = 0, y: CGFloat = 0) {
                self.color = color; self.radius = radius; self.x = x; self.y = y
            }
        }
        public static let quiet = Style(color: .black.opacity(0.045), radius: 5, y: 2)
        public static let card = Style(color: .black.opacity(0.075), radius: 12, y: 5)
        public static let floating = Style(color: .black.opacity(0.12), radius: 20, y: 8)
        public static let focus = Style(color: Color.accentColor.opacity(0.18), radius: 12)
    }
}

extension View {
    func companionShadow(_ style: DS.Shadow.Style) -> some View {
        shadow(color: style.color, radius: style.radius, x: style.x, y: style.y)
    }
}

// MARK: - Reusable surfaces

enum CompanionGlassPanelStyle { case subtle, standard, prominent, inspector }

struct CompanionGlassPanel<Content: View>: View {
    let style: CompanionGlassPanelStyle
    let radius: CGFloat
    let contentPadding: CGFloat
    @ViewBuilder let content: Content

    init(
        style: CompanionGlassPanelStyle = .standard,
        radius: CGFloat = DS.Radius.l,
        contentPadding: CGFloat = DS.Space.l,
        @ViewBuilder content: () -> Content
    ) {
        self.style = style; self.radius = radius; self.contentPadding = contentPadding
        self.content = content()
    }

    private var material: Material {
        switch style {
        case .subtle: return DS.Surface.quietGlass
        case .standard, .inspector: return DS.Surface.glass
        case .prominent: return DS.Surface.elevatedGlass
        }
    }
    private var tint: Color {
        switch style {
        case .subtle: return DS.ColorToken.surfaceSecondary.opacity(0.28)
        case .standard: return DS.ColorToken.surfaceElevated.opacity(0.32)
        case .prominent: return DS.ColorToken.surfaceElevated.opacity(0.56)
        case .inspector: return DS.ColorToken.inspector.opacity(0.54)
        }
    }
    private var panelShadow: DS.Shadow.Style {
        switch style {
        case .subtle: return DS.Shadow.quiet
        case .standard, .inspector: return DS.Shadow.card
        case .prominent: return DS.Shadow.floating
        }
    }

    var body: some View {
        content
            .padding(contentPadding)
            .background {
                RoundedRectangle(cornerRadius: radius, style: .continuous)
                    .fill(material)
                    .overlay {
                        RoundedRectangle(cornerRadius: radius, style: .continuous).fill(tint)
                    }
            }
            .overlay {
                RoundedRectangle(cornerRadius: radius, style: .continuous)
                    .strokeBorder(DS.ColorToken.glassBorder, lineWidth: 0.75)
            }
            .companionShadow(panelShadow)
    }
}

struct CompanionCard<Content: View>: View {
    let title: String?
    let subtitle: String?
    let systemImage: String?
    let style: CompanionGlassPanelStyle
    @ViewBuilder let content: Content

    init(
        title: String? = nil,
        subtitle: String? = nil,
        systemImage: String? = nil,
        style: CompanionGlassPanelStyle = .standard,
        @ViewBuilder content: () -> Content
    ) {
        self.title = title; self.subtitle = subtitle; self.systemImage = systemImage
        self.style = style; self.content = content()
    }

    var body: some View {
        CompanionGlassPanel(style: style) {
            VStack(alignment: .leading, spacing: DS.Space.m) {
                if title != nil || subtitle != nil || systemImage != nil {
                    HStack(alignment: .top, spacing: DS.Space.s) {
                        if let systemImage {
                            Image(systemName: systemImage).foregroundStyle(DS.ColorToken.accent).frame(width: 20)
                        }
                        VStack(alignment: .leading, spacing: 2) {
                            if let title { Text(title).font(DS.Typography.section) }
                            if let subtitle {
                                Text(subtitle).font(DS.Typography.caption).foregroundStyle(DS.ColorToken.textTertiary)
                            }
                        }
                    }
                }
                content
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

struct CompanionSectionHeader<Trailing: View>: View {
    let title: String
    let subtitle: String?
    let systemImage: String?
    @ViewBuilder let trailing: Trailing

    init(
        _ title: String,
        subtitle: String? = nil,
        systemImage: String? = nil,
        @ViewBuilder trailing: () -> Trailing
    ) {
        self.title = title; self.subtitle = subtitle; self.systemImage = systemImage
        self.trailing = trailing()
    }

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: DS.Space.m) {
            if let systemImage {
                Image(systemName: systemImage)
                    .font(.system(size: 14, weight: .semibold)).foregroundStyle(DS.ColorToken.accent)
            }
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(DS.Typography.section).foregroundStyle(DS.ColorToken.textPrimary)
                if let subtitle {
                    Text(subtitle).font(DS.Typography.caption).foregroundStyle(DS.ColorToken.textTertiary)
                }
            }
            Spacer(minLength: DS.Space.m)
            trailing
        }
        .accessibilityElement(children: .contain)
    }
}

extension CompanionSectionHeader where Trailing == EmptyView {
    init(_ title: String, subtitle: String? = nil, systemImage: String? = nil) {
        self.init(title, subtitle: subtitle, systemImage: systemImage) { EmptyView() }
    }
}

// MARK: - Product states

enum CompanionStateKind: String { case loading, empty, error, offline, unconfigured, permission }

struct CompanionStateView: View {
    let kind: CompanionStateKind
    let title: String?
    let message: String?
    let actionTitle: String?
    let action: (() -> Void)?

    init(
        kind: CompanionStateKind,
        title: String? = nil,
        message: String? = nil,
        actionTitle: String? = nil,
        action: (() -> Void)? = nil
    ) {
        self.kind = kind; self.title = title; self.message = message
        self.actionTitle = actionTitle; self.action = action
    }

    private var resolvedTitle: String {
        if let title { return title }
        switch kind {
        case .loading: return "正在准备…"
        case .empty: return "这里还没有内容"
        case .error: return "暂时无法载入"
        case .offline: return "正在等待连接"
        case .unconfigured: return "还需要完成设置"
        case .permission: return "需要你的允许"
        }
    }
    private var icon: String {
        switch kind {
        case .loading: return "circle.dotted"
        case .empty: return "sparkles"
        case .error: return "exclamationmark.triangle"
        case .offline: return "wifi.slash"
        case .unconfigured: return "slider.horizontal.3"
        case .permission: return "hand.raised"
        }
    }
    private var tint: Color {
        switch kind {
        case .error: return DS.ColorToken.danger
        case .offline, .unconfigured, .permission: return DS.ColorToken.warning
        case .loading, .empty: return DS.ColorToken.accent
        }
    }

    var body: some View {
        VStack(spacing: DS.Space.m) {
            if kind == .loading {
                ProgressView().controlSize(.small)
            } else {
                Image(systemName: icon)
                    .font(.system(size: 22, weight: .medium)).foregroundStyle(tint)
                    .frame(width: 48, height: 48).background(tint.opacity(0.11), in: Circle())
            }
            VStack(spacing: DS.Space.xs) {
                Text(resolvedTitle).font(DS.Typography.section).foregroundStyle(DS.ColorToken.textPrimary)
                if let message, !message.isEmpty {
                    Text(message).font(DS.Typography.secondary).foregroundStyle(DS.ColorToken.textSecondary)
                        .multilineTextAlignment(.center).lineLimit(4)
                }
            }
            if let actionTitle, let action {
                Button(actionTitle, action: action)
                    .buttonStyle(.borderedProminent)
                    .controlSize(.small)
                    .tint(DS.ColorToken.accent)
            }
        }
        .frame(maxWidth: 440)
        .padding(DS.Space.xxl)
        .accessibilityElement(children: .contain)
    }
}

struct CompanionMetricTile: View {
    let title: String
    let value: String
    let subtitle: String?
    let systemImage: String?
    let tint: Color

    init(
        title: String,
        value: String,
        subtitle: String? = nil,
        systemImage: String? = nil,
        tint: Color = DS.ColorToken.accent
    ) {
        self.title = title; self.value = value; self.subtitle = subtitle
        self.systemImage = systemImage; self.tint = tint
    }

    var body: some View {
        CompanionGlassPanel(style: .subtle, contentPadding: DS.Space.l) {
            VStack(alignment: .leading, spacing: DS.Space.s) {
                HStack(spacing: DS.Space.s) {
                    if let systemImage { Image(systemName: systemImage).foregroundStyle(tint) }
                    Text(title).font(DS.Typography.caption).foregroundStyle(DS.ColorToken.textSecondary)
                }
                Text(value).font(DS.Typography.metric).foregroundStyle(DS.ColorToken.textPrimary)
                    .lineLimit(1).minimumScaleFactor(0.72)
                if let subtitle {
                    Text(subtitle).font(DS.Typography.caption).foregroundStyle(DS.ColorToken.textTertiary).lineLimit(2)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(title)，\(value)\(subtitle.map { "，\($0)" } ?? "")")
    }
}

// MARK: - Compatibility components

struct EmptyStateView: View {
    let icon: String
    let title: String
    var subtitle: String? = nil
    var body: some View {
        VStack(spacing: DS.Space.m) {
            Image(systemName: icon).font(.system(size: 34, weight: .light)).foregroundStyle(DS.ColorToken.textTertiary)
            Text(title).font(DS.Typography.section).foregroundStyle(DS.ColorToken.textSecondary)
            if let subtitle {
                Text(subtitle).font(DS.Typography.caption).foregroundStyle(DS.ColorToken.textTertiary)
                    .multilineTextAlignment(.center)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity).padding(DS.Space.xl)
        .accessibilityElement(children: .combine)
    }
}

struct StatusDot: View {
    let connected: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    var body: some View {
        Circle()
            .fill(connected ? DS.ColorToken.success : DS.ColorToken.warning)
            .frame(width: 8, height: 8)
            .overlay(Circle().strokeBorder(.white.opacity(0.28), lineWidth: 0.5))
            .animation(DS.Motion.animation(.fast, reduceMotion: reduceMotion), value: connected)
            .accessibilityHidden(true)
    }
}

struct TagChip: View {
    let text: String
    var tint: Color = DS.ColorToken.textSecondary
    var body: some View {
        Text(text)
            .font(.caption2.weight(.medium))
            .padding(.horizontal, DS.Space.s).padding(.vertical, 3)
            .background(tint.opacity(0.11)).foregroundStyle(tint).clipShape(Capsule())
            .overlay(Capsule().strokeBorder(tint.opacity(0.14), lineWidth: 0.5))
    }
}
