import SwiftUI
import AppKit

/// IME-safe 的 Composer 文本视图（NSTextView bridge）。
///
/// Return → 发送；Shift+Return → 换行。
/// 中文/日文输入法 composing（marked text）期间 Return 只确认候选词，绝不触发发送。
/// 不使用全局 key monitor；行为完全限定在这个 TextView 内。
struct ComposerTextView: NSViewRepresentable {
    @Binding var text: String
    var focused: FocusState<Bool>.Binding
    var canSend: Bool
    var onSend: () -> Void

    static let isComposingNotification = Notification.Name("composerTextIsComposingChanged")

    func makeNSView(context: Context) -> NSScrollView {
        let scrollView = NSScrollView()
        scrollView.hasVerticalScroller = true
        scrollView.drawsBackground = false
        scrollView.autohidesScrollers = true
        scrollView.scrollerStyle = .overlay

        let textView = ComposerTextViewBacking()
        textView.isRichText = false
        textView.allowsUndo = true
        textView.drawsBackground = false
        textView.isVerticallyResizable = true
        textView.textContainer?.widthTracksTextView = true
        textView.textContainerInset = NSSize(width: 2, height: 8)
        textView.delegate = context.coordinator
        textView.coordinator = context.coordinator
        textView.font = NSFont.systemFont(ofSize: NSFont.systemFontSize)
        textView.textColor = .labelColor
        textView.isContinuousSpellCheckingEnabled = false

        scrollView.documentView = textView
        context.coordinator.textView = textView

        return scrollView
    }

    func updateNSView(_ nsView: NSScrollView, context: Context) {
        guard let textView = nsView.documentView as? ComposerTextViewBacking else { return }
        context.coordinator.parent = self
        // 关键 IME 细节：composing（marked text）期间绝不用 binding 覆写内容，
        // 否则会打断输入法组合。
        if textView.string != text && !textView.hasMarkedText() {
            textView.string = text
        }
        if focused.wrappedValue && textView.window?.firstResponder !== textView {
            textView.window?.makeFirstResponder(textView)
        }
    }

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    @MainActor
    final class Coordinator: NSObject, NSTextViewDelegate {
        var parent: ComposerTextView
        weak var textView: ComposerTextViewBacking?

        init(_ parent: ComposerTextView) {
            self.parent = parent
        }

        func textDidChange(_ notification: Notification) {
            guard let textView else { return }
            parent.text = textView.string
        }

        /// 键盘命令拦截：Return 的发送/换行/IME 分流。
        /// 返回 true 表示已处理（阻止默认插入换行）。
        func textView(_ view: NSTextView, doCommandBy commandSelector: Selector) -> Bool {
            if commandSelector == #selector(NSResponder.insertNewline(_:)) {
                let shift = NSApp.currentEvent?.modifierFlags.contains(.shift) ?? false
                // Shift+Return：换行，走默认行为
                if shift { return false }
                // IME composing：Return 只确认候选词，交给输入法
                if view.hasMarkedText() { return false }
                // 可发送则发送（与发送按钮同一 action）；不可发送吞掉 Return（不插入空行）
                if parent.canSend {
                    parent.onSend()
                    return true
                }
                return true
            }
            return false
        }
    }
}

/// 记录 composing 状态供高度计算使用（marked text 期间高度不抖动）。
@MainActor
final class ComposerTextViewBacking: NSTextView {
    weak var coordinator: ComposerTextView.Coordinator?

    override func insertText(_ string: Any, replacementRange: NSRange) {
        super.insertText(string, replacementRange: replacementRange)
        NotificationCenter.default.post(name: ComposerTextView.isComposingNotification, object: self)
    }

    override func setMarkedText(_ string: Any, selectedRange: NSRange, replacementRange: NSRange) {
        super.setMarkedText(string, selectedRange: selectedRange, replacementRange: replacementRange)
        NotificationCenter.default.post(name: ComposerTextView.isComposingNotification, object: self)
    }

    override func unmarkText() {
        super.unmarkText()
        NotificationCenter.default.post(name: ComposerTextView.isComposingNotification, object: self)
    }
}
