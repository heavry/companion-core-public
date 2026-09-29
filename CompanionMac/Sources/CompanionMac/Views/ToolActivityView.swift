import SwiftUI
import CompanionKit
import AppKit

struct ToolActivityView: View {
    let events: [RealtimeEvent]

    var body: some View {
        List {
            ForEach(Array(events.enumerated()), id: \.offset) { _, e in
                VStack(alignment: .leading, spacing: 2) {
                    HStack {
                        Image(systemName: icon(for: e.type))
                        Text(e.type).font(.system(.footnote, design: .monospaced)).bold()
                        if let sid = e.sessionId {
                            Text("· \(sid.prefix(8))").font(.caption2).foregroundStyle(.secondary)
                        }
                        Spacer()
                        Text(e.at.map { CompanionTime.naturalDateTime(fromISO8601: $0) } ?? "").font(.caption2).foregroundStyle(.tertiary)
                    }
                    if let d = e.data, case .dictionary(let dict) = d {
                        ForEach(["name", "tool", "moduleId"], id: \.self) { k in
                            if let v = dict[k]?.stringValue {
                                Text("\(k): \(v)").font(.caption)
                            }
                        }
                        // 大体积输出只显示截断预览（Core 已保证 ≤400 字符）
                        if let preview = dict["output_preview"]?.stringValue ?? dict["preview"]?.stringValue {
                            Text(preview).font(.caption).foregroundStyle(.secondary).lineLimit(3)
                        }
                    }
                }.padding(.vertical, 2)
            }
            if events.isEmpty {
                Text("暂无 Agent / Tool 活动。开始一次 OpenCode/Harness 任务后这里会实时出现 read/edit/bash 等活动。")
                    .foregroundStyle(.secondary)
            }
        }
    }

    private func icon(for type: String) -> String {
        switch type {
        case "tool.started": "play.circle"
        case "tool.completed": "checkmark.circle"
        case "tool.failed", "module.failed": "xmark.octagon"
        case "module.started", "module.completed": "puzzlepiece"
        case "agent.started": "bolt"
        default: "circle"
        }
    }
}
