import SwiftUI
import CompanionKit

struct SidebarView: View {
    @ObservedObject var connection: ConnectionViewModel
    @Binding var filter: String?
    let categories: [(String?, String, String)] = [
        (nil, "全部会话", "tray.full"),
        ("daily", "日常聊天", "sun.max"),
        ("agents", "Agents", "hammer"),
        ("proactive", "主动消息", "sparkles"),
        ("system", "System / Module", "cpu")
    ]

    var body: some View {
        List {
            Section {
                HStack {
                    Circle().fill(connection.status == .connected ? Color.green : Color.orange).frame(width: 8, height: 8)
                    Text(connection.status == .connected ? "Online" : connection.status == .connecting ? "Connecting" : "Offline")
                        .font(.footnote)
                }
            }
            ForEach(categories, id: \.0) { item in
                Button {
                    filter = item.0
                } label: {
                    Label(item.1, systemImage: item.2)
                }
                .buttonStyle(.plain)
            }
        }
        .listStyle(.sidebar)
        .frame(minWidth: 190)
    }
}
