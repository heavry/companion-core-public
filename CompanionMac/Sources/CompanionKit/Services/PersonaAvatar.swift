import AppKit

/// Persona 头像资源（林小糖 canonical avatar）。
/// 唯一资源：PersonaAvatar = 用户提供的 1254×1254 原始整图，
/// 完整构图显示（.fit + 轻圆角），不做任何裁剪/放大。
/// 图片位于 CompanionKit 的 Assets.xcassets，随 App bundle 打包；
/// 资源缺失时返回 nil，调用方回退到首字渐变占位。
public enum PersonaAvatar {
    public static var image: NSImage? {
        image(mainBundle: .main, moduleBundle: .module)
    }

    /// Resolve the installed App layout directly instead of relying on an
    /// asset-catalog lookup. SwiftPM copies this catalog as loose files, so
    /// `image(forResource:)` legitimately returns nil even when the PNG exists.
    static func image(mainBundle: Bundle, moduleBundle: Bundle?) -> NSImage? {
        for url in resourceCandidates(mainBundle: mainBundle, moduleBundle: moduleBundle) {
            if let image = NSImage(contentsOf: url) { return image }
        }
        return nil
    }

    static func resourceCandidates(mainBundle: Bundle, moduleBundle: Bundle?) -> [URL] {
        let relativePath = "Assets.xcassets/PersonaAvatar.imageset/PersonaAvatar.png"
        let bundleName = "CompanionMac_CompanionKit.bundle"
        var roots: [URL] = []

        // Normal installed .app layout.
        if let resources = mainBundle.resourceURL {
            roots.append(resources.appendingPathComponent(bundleName, isDirectory: true))
        }
        // Compatibility with the original v0.2.6.1 package layout.
        roots.append(mainBundle.bundleURL.appendingPathComponent(bundleName, isDirectory: true))
        // SwiftPM tests and command-line development builds.
        if let moduleBundle { roots.append(moduleBundle.bundleURL) }

        var seen = Set<String>()
        return roots
            .map { $0.appendingPathComponent(relativePath) }
            .filter { seen.insert($0.standardizedFileURL.path).inserted }
    }
}
