import SwiftUI
import AppKit
import CompanionKit

struct WakeOverlayView: View {
    @ObservedObject var wake: WakeWordRuntime

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("林小糖")
                .font(.headline)
            Text(wake.overlayText.isEmpty ? wake.phase.title : wake.overlayText)
                .font(.subheadline)
                .foregroundStyle(DS.ColorToken.textSecondary)
                .lineLimit(3)
        }
        .padding(14)
        .frame(minWidth: 220, maxWidth: 280, alignment: .leading)
        .background(DS.ColorToken.surface, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
    }
}

@MainActor
final class WakeOverlayController {
    private var panel: NSPanel?
    private var hosting: NSHostingView<WakeOverlayView>?

    func show(wake: WakeWordRuntime) {
        if panel == nil {
            let panel = NSPanel(
                contentRect: NSRect(x: 0, y: 0, width: 280, height: 88),
                styleMask: [.borderless, .nonactivatingPanel],
                backing: .buffered,
                defer: false
            )
            panel.isFloatingPanel = true
            panel.level = .statusBar
            panel.hidesOnDeactivate = false
            panel.backgroundColor = .clear
            panel.isOpaque = false
            panel.hasShadow = true
            panel.isReleasedWhenClosed = false
            panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
            self.panel = panel
        }
        let view = NSHostingView(rootView: WakeOverlayView(wake: wake))
        hosting = view
        panel?.contentView = view
        position()
        panel?.orderFrontRegardless()
    }

    func hide() {
        panel?.orderOut(nil)
    }

    private func position() {
        guard let screen = NSScreen.main, let panel else { return }
        let frame = screen.visibleFrame
        let size = panel.frame.size
        panel.setFrameOrigin(NSPoint(x: frame.midX - size.width / 2, y: frame.maxY - size.height - 48))
    }
}
