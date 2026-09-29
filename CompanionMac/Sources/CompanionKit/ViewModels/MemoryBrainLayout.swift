import Foundation
import CoreGraphics

public enum MemoryBrainLayout {
    public static func positions(nodes: [MemoryBrainResponse.Node], in size: CGSize) -> [String: CGPoint] {
        guard !nodes.isEmpty, size.width > 0, size.height > 0 else { return [:] }
        let center = CGPoint(x: size.width / 2, y: size.height / 2)
        let horizontal = max(125, size.width * 0.45)
        let vertical = max(105, size.height * 0.39)
        let anchor = nodes.filter { $0.visualTier == "major" }.sorted {
            if $0.pinned != $1.pinned { return $0.pinned }
            if $0.importance != $1.importance { return $0.importance > $1.importance }
            return $0.id < $1.id
        }.first
        let slotCount = nodes.count <= 20 ? 24 : 48
        var occupied: [String: Set<Int>] = [:]
        var result: [String: CGPoint] = [:]
        if let anchor { result[anchor.id] = center }
        for node in nodes.filter({ $0.id != anchor?.id }).sorted(by: { $0.layout.angle < $1.layout.angle }) {
            let desired = Int((node.layout.angle / (Double.pi * 2) * Double(slotCount)).rounded()) % slotCount
            let gap = node.visualTier == "major" ? 4 : node.visualTier == "state" ? 3 : 2
            let used = occupied[node.visualTier, default: []]
            let slot = nearestFreeSlot(desired: desired, count: slotCount, minimumGap: gap, used: used)
            occupied[node.visualTier, default: []].insert(slot)
            let angle = CGFloat(slot) / CGFloat(slotCount) * .pi * 2
            let radius: CGFloat = node.visualTier == "major" ? 0.48 : node.visualTier == "state" ? 0.69 : 0.88
            let depth = CGFloat(min(1, max(0, node.layout.depth)))
            let x = center.x + cos(angle) * horizontal * radius
            let y = center.y + sin(angle) * vertical * radius * (0.82 + depth * 0.18)
            result[node.id] = CGPoint(x: x, y: y)
        }
        return result
    }

    public static func diameter(for tier: String) -> CGFloat {
        switch tier { case "major": return 88; case "state": return 64; default: return 46 }
    }

    private static func nearestFreeSlot(desired: Int, count: Int, minimumGap: Int, used: Set<Int>) -> Int {
        guard !used.isEmpty else { return desired }
        for distance in 0..<count {
            for candidate in [desired + distance, desired - distance] {
                let slot = (candidate % count + count) % count
                let clear = used.allSatisfy { existing in
                    let delta = abs(existing - slot), wrapped = min(delta, count - delta)
                    return wrapped >= minimumGap
                }
                if clear { return slot }
            }
        }
        return desired
    }
}
