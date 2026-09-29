import Foundation

/// Local-only durability for remote voice plans. It records synthesis and
/// playback state without changing cloud conversation history.
public final class RemoteVoicePlanStore: @unchecked Sendable {
    public struct Entry: Codable, Equatable {
        public var synthesized: Bool
        public var played: Bool
        public var audioFilename: String?
    }

    private let directory: URL
    private let stateURL: URL
    private let lock = NSLock()
    private var entries: [String: Entry]

    public init(directory: URL? = nil) {
        let root = directory ?? FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("companion-core/remote-voice", isDirectory: true)
        self.directory = root
        self.stateURL = root.appendingPathComponent("state.json")
        try? FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        if let data = try? Data(contentsOf: stateURL),
           let decoded = try? JSONDecoder().decode([String: Entry].self, from: data) {
            self.entries = decoded
        } else {
            self.entries = [:]
        }
    }

    public func entry(for generationID: String) -> Entry? {
        lock.lock(); defer { lock.unlock() }
        return entries[generationID]
    }

    public func audio(for generationID: String) -> Data? {
        lock.lock()
        let filename = entries[generationID]?.audioFilename
        lock.unlock()
        guard let filename else { return nil }
        return try? Data(contentsOf: directory.appendingPathComponent(filename))
    }

    public func saveAudio(_ data: Data, generationID: String) throws {
        let filename = safeFilename(generationID) + ".wav"
        try data.write(to: directory.appendingPathComponent(filename), options: .atomic)
        mutate(generationID) { $0 = Entry(synthesized: true, played: $0?.played ?? false, audioFilename: filename) }
    }

    public func markPlayed(_ generationID: String) {
        mutate(generationID) {
            $0 = Entry(synthesized: $0?.synthesized ?? false, played: true, audioFilename: $0?.audioFilename)
        }
    }

    private func mutate(_ generationID: String, _ body: (inout Entry?) -> Void) {
        lock.lock()
        var value = entries[generationID]
        body(&value)
        entries[generationID] = value
        let snapshot = entries
        lock.unlock()
        if let data = try? JSONEncoder().encode(snapshot) { try? data.write(to: stateURL, options: .atomic) }
    }

    private func safeFilename(_ value: String) -> String {
        Data(value.utf8).base64EncodedString()
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "=", with: "")
    }
}
