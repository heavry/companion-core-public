import SwiftUI
import CompanionKit

/// 首次使用引导：API Key 缺失时显示；保存进 macOS Keychain 后进入主界面。
struct ConnectionSetupView: View {
    let onSaved: (String) -> Void
    @State private var key = ""
    @State private var errorText: String?
    @FocusState private var fieldFocused: Bool

    var body: some View {
        VStack(spacing: DS.Space.l) {
            AvatarView(name: "林小糖", size: 64)
            Text("连接 Companion Core")
                .font(.title3.weight(.semibold))
            Text("粘贴 Candidate Core 的 API Key。\n它只会保存在本机 macOS Keychain 中。")
                .font(DS.Typography.caption)
                .foregroundStyle(DS.ColorToken.textSecondary)
                .multilineTextAlignment(.center)
            SecureField("Companion API Key", text: $key)
                .textFieldStyle(.roundedBorder)
                .frame(width: 340)
                .focused($fieldFocused)
                .onSubmit(save)
            Button("保存并连接") { save() }
                .keyboardShortcut(.defaultAction)
                .disabled(key.trimmingCharacters(in: .whitespaces).count < 8)
            if let errorText {
                Text(errorText).font(.caption).foregroundStyle(DS.ColorToken.danger)
            }
            Text("目标：\(AppModel.serverBaseURL().absoluteString)\(AppModel.isCandidateTarget ? "  ·  CANDIDATE" : "")")
                .font(.system(size: 10, design: .monospaced))
                .foregroundStyle(DS.ColorToken.textTertiary)
        }
        .padding(DS.Space.xxl)
        .frame(minWidth: 480, minHeight: 360)
        .onAppear { fieldFocused = true }
    }

    private func save() {
        let trimmed = key.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.count >= 8 else {
            errorText = "Key 看起来太短，请检查后重试。"
            return
        }
        Task {
            do {
                try await KeychainStore().saveAsync(trimmed, account: "apiKey")
                CredentialCache.shared.replace(with: trimmed)
                Breadcrumb.emit("setup key saved to keychain")
                onSaved(trimmed)
            } catch {
                errorText = "无法写入 Keychain：\(error.localizedDescription)"
            }
        }
    }
}
