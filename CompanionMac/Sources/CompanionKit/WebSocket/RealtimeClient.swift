import Foundation
#if canImport(Network)
import Network
#endif

@inline(__always) func logRT(_ msg: String) {
    let line = "[realtime] " + msg + "\n"
    FileHandle.standardError.write(Data(line.utf8))
}

/// 实时事件订阅客户端（WebSocket）。整个类 MainActor 隔离：
/// 所有状态（task/status/attempt）只在主线程读写，消除跨线程数据竞争。
/// - 鉴权：仅 Authorization header
/// - 重连：指数退避 1s→2s→…→60s，收到首帧即视为成功并清零
/// - 网络恢复（NWPathMonitor）立即尝试重连
@MainActor
public final class RealtimeClient {
    public enum Status: Equatable { case idle, connecting, connected, closed }

    /// 不可变连接配置。Sendable 保证跨隔离域读取安全；
    /// tokenProvider 使用 @Sendable 闭包，调用方不得捕获可变状态。
    private struct Config: Sendable {
        let baseURL: URL
        let tokenProvider: @Sendable () -> String
    }

    private let config: Config
    private var task: URLSessionWebSocketTask?
    private var session: URLSession?
    public private(set) var status: Status = .idle
    private var reconnectAttempt = 0

    public var onEvent: ((RealtimeEvent) -> Void)?
    public var onStatusChange: ((Status) -> Void)?

    public init(baseURL: URL, tokenProvider: @escaping @Sendable () -> String) {
        self.config = Config(baseURL: baseURL, tokenProvider: tokenProvider)
    }

    private func wsURL() -> URL? {
        guard var comps = URLComponents(url: config.baseURL, resolvingAgainstBaseURL: false) else { return nil }
        comps.scheme = comps.scheme == "https" ? "wss" : "ws"
        comps.path = "/ws"
        return comps.url
    }

    public func connect() {
        guard status == .idle || status == .closed else { return }
        setStatus(.connecting)
        Breadcrumb.emit("ws connecting")
        guard let url = wsURL() else { setStatus(.closed); return }
        var request = URLRequest(url: url)
        request.setValue("Bearer \(config.tokenProvider())", forHTTPHeaderField: "Authorization")
        let s = session ?? URLSession(configuration: .default)
        session = s
        let t = s.webSocketTask(with: request)
        task = t
        t.resume()
        setStatus(.connected) // 乐观置位；失败路径由 receive 错误 / ping 超时纠正
        Task { await pump(on: t) }
        installNetworkWatch()
    }

    /// 挂起式接收循环：await 不阻塞主线程；状态全部在 MainActor 上变更
    private func pump(on task: URLSessionWebSocketTask) async {
        while task === self.task && status == .connected {
            let message: URLSessionWebSocketTask.Message
            do { message = try await task.receive() }
            catch {
                if !Task.isCancelled {
                    Breadcrumb.emit("ws failure")
                    scheduleReconnect(reason: error.localizedDescription)
                }
                return
            }
            if reconnectAttempt != 0 {
                reconnectAttempt = 0
                Breadcrumb.emit("ws connected (backoff reset)")
            }
            startPingLoop(on: task)
            switch message {
            case .string(let text):
                if let event = RealtimeClient.decode(text: text) {
                    Breadcrumb.emit("ws event \(event.type)")
                    onEvent?(event)
                }
            default: break
            }
        }
    }

    nonisolated static func decode(text: String) -> RealtimeEvent? {
        guard let data = text.data(using: .utf8),
              let wire = try? JSONDecoder().decode(RealtimeWireEvent.self, from: data) else { return nil }
        guard !["hello", "pong", "error"].contains(wire.type) else { return nil }
        return RealtimeEvent(type: wire.type, eventId: wire.eventId, at: wire.at,
                             sessionId: wire.sessionId, data: wire.data?.strippingSensitiveKeys())
    }

    private func scheduleReconnect(reason: String) {
        guard status == .connected || status == .connecting else { return }
        setStatus(.closed)
        reconnectAttempt += 1
        let delay = min(60.0, pow(2.0, Double(max(0, reconnectAttempt - 1))))
        Breadcrumb.emit("reconnect #\(reconnectAttempt) in \(Int(delay))s")
        Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
            guard let self, self.status == .closed else { return }
            self.status = .idle
            self.connect()
        }
    }

    private var pingLoopTask: Task<Void, Never>?
    private var networkMonitorInstalled = false

    /// 应用层保活：URLSession WebSocket 对静默断链（对端崩溃/网络中断）不会自动
    /// 唤醒挂起的 receive()；周期性 ping + 超时判定是唯一可靠手段。
    private func startPingLoop(on task: URLSessionWebSocketTask) {
        pingLoopTask?.cancel()
        pingLoopTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 20_000_000_000)
                guard let self, self.task === task, self.status == .connected else { return }
                Breadcrumb.emit("ws ping")
                let pongReceived = await self.pingWithTimeout(task, timeout: 10)
                if !pongReceived {
                    Breadcrumb.emit("ws ping timeout -> reconnect")
                    task.cancel(with: .goingAway, reason: nil)
                    scheduleReconnect(reason: "ping timeout")
                    return
                }
            }
        }
    }

    private func pingWithTimeout(_ task: URLSessionWebSocketTask, timeout: TimeInterval) async -> Bool {
        await withCheckedContinuation { continuation in
            var resumed = false
            let timer = DispatchSource.makeTimerSource(queue: .main)
            timer.schedule(deadline: .now() + timeout)
            timer.setEventHandler { [weak self] in
                guard !resumed else { return }
                resumed = true
                _ = self // 保持 self 存活至回调结束
                continuation.resume(returning: false)
            }
            timer.resume()
            task.sendPing { [weak self] error in
                guard !resumed else { return }
                resumed = true
                timer.cancel()
                _ = self
                continuation.resume(returning: error == nil)
            }
        }
    }
    private func installNetworkWatch() {
        #if canImport(Network)
        guard !networkMonitorInstalled else { return }
        networkMonitorInstalled = true
        let monitor = NWPathMonitor()
        monitor.pathUpdateHandler = { [weak self] path in
            guard path.status == .satisfied else { return }
            Task { @MainActor in
                guard let self, self.status == .closed else { return }
                Breadcrumb.emit("network satisfied -> immediate reconnect")
                self.reconnectAttempt = 0
                self.status = .idle
                self.connect()
            }
        }
        monitor.start(queue: DispatchQueue(label: "companion.realtime.path"))
        #endif
    }

    func setStatus(_ s: Status) {
        status = s
        onStatusChange?(s)
    }

    public func disconnect() {
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
        setStatus(.closed)
    }
}
