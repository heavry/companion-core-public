import SwiftUI
import CompanionKit

struct VoiceCallSurface: View {
    @ObservedObject var call: VoiceCallManager
    let onEnd: () -> Void
    var body: some View {
        HStack(alignment: .center, spacing: DS.Space.m) {
            AvatarView(name: "林小糖", size: 48)
            VStack(alignment: .leading, spacing: 4) {
                Text("林小糖").font(.subheadline.weight(.semibold))
                HStack(spacing: DS.Space.s) {
                    VoiceLevelMeter(level: call.inputLevel, speaking: call.phase == .userSpeaking || call.phase == .assistantSpeaking)
                    Text(statusTitle)
                        .font(.caption)
                        .foregroundStyle(call.phase == .error ? DS.ColorToken.danger : DS.ColorToken.textSecondary)
                }
                ForEach(Array(call.recentTurns.prefix(2).enumerated()), id: \.offset) { _, line in
                    Text(line).font(.caption2).foregroundStyle(DS.ColorToken.textTertiary).lineLimit(1)
                }
            }
            Spacer()
            if call.phase == .assistantSpeaking {
                Button { call.stopSpeaking() } label: { Label("停止", systemImage: "stop.fill") }.buttonStyle(.bordered)
            }
            if call.isActive {
                Button { call.toggleMute() } label: {
                    Label(call.isMuted ? "已静音" : "静音", systemImage: call.isMuted ? "mic.slash.fill" : "mic.fill")
                }
                .buttonStyle(.bordered)
            }
            Button(role: .destructive, action: onEnd) { Label("结束", systemImage: "phone.down.fill") }
                .buttonStyle(.borderedProminent).tint(DS.ColorToken.danger)
        }
        .padding(.horizontal, DS.Space.l).padding(.vertical, DS.Space.m)
        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: DS.Radius.l, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: DS.Radius.l).strokeBorder(DS.ColorToken.separator.opacity(0.6)))
        .padding(.horizontal, DS.Space.xl).padding(.top, DS.Space.s)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("与林小糖的语音通话，\(statusTitle)")
    }

    private var statusTitle: String {
        if call.isMuted && call.isActive { return "已静音" }
        if let errorText = call.errorText, call.phase == .error { return errorText }
        return call.phase.title
    }
}

private struct VoiceLevelMeter: View {
    let level: Float
    let speaking: Bool
    var body: some View {
        HStack(spacing: 2) {
            ForEach(0..<5, id: \.self) { index in
                Capsule()
                    .fill(level > Float(index) * 0.018 ? DS.ColorToken.accent : DS.ColorToken.separator.opacity(0.5))
                    .frame(width: 3, height: speaking ? 6 + CGFloat(index) * 2.5 : 5)
            }
        }
        .accessibilityHidden(true)
    }
}
