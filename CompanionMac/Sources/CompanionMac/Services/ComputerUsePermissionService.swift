import AppKit
import ApplicationServices
import CoreGraphics

struct ComputerUseMacPermissionState: Equatable {
    let accessibility: Bool
    let screenRecording: Bool
    var ready: Bool { accessibility && screenRecording }
}

enum ComputerUsePermissionService {
    static func current() -> ComputerUseMacPermissionState {
        .init(accessibility: AXIsProcessTrusted(), screenRecording: CGPreflightScreenCaptureAccess())
    }

    @discardableResult static func requestAccessibility() -> Bool {
        let key = kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String
        return AXIsProcessTrustedWithOptions([key: true] as CFDictionary)
    }

    @discardableResult static func requestScreenRecording() -> Bool {
        CGRequestScreenCaptureAccess()
    }

    static func openAccessibilitySettings() {
        openSettings("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")
    }

    static func openScreenRecordingSettings() {
        openSettings("x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture")
    }

    private static func openSettings(_ value: String) {
        if let url = URL(string: value) { NSWorkspace.shared.open(url) }
    }
}
