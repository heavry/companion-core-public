import Foundation
#if canImport(Darwin)
import Darwin
#endif

/// Candidate Core (:8770) 进程管理器。
///
/// 职责：
///  - 探测健康状态；未运行则以子进程方式安全启动（无 Terminal 窗口）
///  - Finder 双击场景：显式解析 node 绝对路径，不依赖 shell PATH
///  - secret 不进命令行参数：API Key 由 Core 自身从仓库 .env 读取，
///    本管理器只注入非敏感的端口/路径环境变量
///  - 所有权：记录是否由本 App 拉起；Quit 时仅终止自己拉起的实例
///  - 崩溃恢复：连续失败计数 + 上限，防止 crash loop
@MainActor
public final class CoreProcessManager: ObservableObject {
    public enum Phase: Equatable {
        case idle
        case starting
        case running(ownedByApp: Bool)
        case failed(String)

        public var isFailed: Bool { if case .failed = self { return true }; return false }
        public var failureDetail: String? { if case .failed(let m) = self { return m }; return nil }
    }

    @Published public private(set) var phase: Phase = .idle
    @Published public private(set) var failureMessage: String?
    public private(set) var ownedByApp = false

    private var process: Process?
    private var logHandle: FileHandle?
    private var recoveryTask: Task<Void, Never>?
    private var stabilityTask: Task<Void, Never>?
    private var consecutiveFailures = 0
    private let maxConsecutiveFailures = 3
    private var automaticRestartAttempts = 0
    private var automaticRecoverySuppressed = false
    public let deploymentMode: CoreDeploymentMode

    public init(mode: CoreDeploymentMode = .local) { self.deploymentMode = mode }

    // MARK: - 配置解析（UserDefaults 覆盖 → 常见绝对路径探测）

    public func resolveNodePath() -> String? {
        if let custom = UserDefaults.standard.string(forKey: "candidateNodePath"),
           FileManager.default.isExecutableFile(atPath: custom) {
            return custom
        }
        let candidates = ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"]
        return candidates.first { FileManager.default.isExecutableFile(atPath: $0) }
    }

    public func resolveServerEntry() -> String? {
        if let custom = UserDefaults.standard.string(forKey: "serverEntryPath"),
           FileManager.default.fileExists(atPath: custom) {
            return custom
        }
        let home = NSHomeDirectory()
        let candidates = [
            "\(home)/Downloads/companion-core-v0.1.2/companion-core-v0.1.2/src/server.js",
            "\(home)/Downloads/companion-core-v0.1.2/src/server.js",
            "\(home)/companion-core/src/server.js"
        ]
        return candidates.first { FileManager.default.fileExists(atPath: $0) }
    }

    var repoRoot: String? {
        resolveServerEntry().flatMap { entry -> String? in
            let url = URL(fileURLWithPath: entry)
            guard url.lastPathComponent == "server.js" else { return nil }
            return url.deletingLastPathComponent().deletingLastPathComponent().path
        }
    }

    static var dataDirectory: String {
        let dir = NSHomeDirectory() + "/Library/Application Support/CompanionCore-candidate"
        return dir
    }

    // MARK: - 健康探测

    public nonisolated func isHealthy(baseURL: URL = URL(string: "http://127.0.0.1:8770")!) async -> Bool {
        var request = URLRequest(url: baseURL.appendingPathComponent("health"))
        request.timeoutInterval = 2
        guard let (_, response) = try? await URLSession.shared.data(for: request),
              let http = response as? HTTPURLResponse else { return false }
        return (200..<300).contains(http.statusCode)
    }

    // MARK: - 启动 / 停止

    /// 确保 candidate Core 可用。已运行 → 直接复用；否则启动并等待 ready。
    public func ensureRunning(waitSeconds: Int = 15) async -> Bool {
        guard deploymentMode == .local else {
            fail("CORE_MODE=remote：已拒绝启动本机 Candidate Core。")
            return false
        }
        phase = .starting
        Breadcrumb.emit("core.launch probe")
        if await isHealthy() {
            phase = .running(ownedByApp: ownedByApp)
            consecutiveFailures = 0
            failureMessage = nil
            if !ownedByApp {
                automaticRestartAttempts = 0
                automaticRecoverySuppressed = false
            }
            Breadcrumb.emit("core.launch reuse")
            return true
        }
        if automaticRecoverySuppressed {
            let message = "Candidate Core 自动恢复连续失败 \(maxConsecutiveFailures) 次，已停止自动拉起，请手动重试。"
            failureMessage = message
            phase = .failed(message)
            return false
        }
        guard let node = resolveNodePath(),
              let entry = resolveServerEntry(),
              let repo = repoRoot,
              FileManager.default.isExecutableFile(atPath: node) else {
                fail("未找到可用的 Node 运行时或 Core 入口（src/server.js）。请在 设置→连接 中配置路径。")
                return false
        }

        let dataDir = Self.dataDirectory
        try? FileManager.default.createDirectory(atPath: dataDir, withIntermediateDirectories: true)
        let logPath = dataDir + "/core.log"

        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: node)
        proc.arguments = [entry]
        proc.currentDirectoryURL = URL(fileURLWithPath: repo)
        proc.environment = [
            "HOME": NSHomeDirectory(),
            "PATH": "/usr/bin:/bin",
            "COMPANION_HOST": "127.0.0.1",
            "COMPANION_PORT": "8770",
            "CORE_MODE": "local",
            "COMPANION_DEPLOYMENT_ROLE": "local-primary",
            "DATABASE_PATH": dataDir + "/companion.db",
            "COMPANION_INSTANCE_ID_PATH": dataDir + "/instance-identity.json",
            "COMPANION_PRIMARY_LOCK_PATH": dataDir + "/primary-instance.lock",
            "COMPANION_MODULES_STATE_PATH": dataDir + "/modules-state.json",
            "COMPANION_MODULE_EXECUTION_LEDGER_PATH": dataDir + "/module-execution-ledger.json",
            "COMPANION_STATE_PATH": dataDir + "/companion-state.json",
            "COMPANION_BEHAVIOR_PATH": dataDir + "/companion-behavior.json",
            "COMPANION_MODULES_CONFIG_DIR": dataDir + "/modules-config",
            "PERSONA_SYNC_ON_START": "false",
            "EMBEDDING_ENABLED": "false"
        ]
        guard let logHandle = (FileHandle(forWritingAtPath: logPath) ?? {
            FileManager.default.createFile(atPath: logPath, contents: nil)
            return FileHandle(forWritingAtPath: logPath)
        }()) else {
            fail("无法创建 candidate Core 日志文件：\(logPath)")
            return false
        }
        do {
            try logHandle.seekToEnd()
        } catch {
            try? logHandle.close()
            fail("无法打开 candidate Core 日志文件：\(logPath)")
            return false
        }
        proc.standardOutput = logHandle
        proc.standardError = logHandle
        proc.terminationHandler = { [weak self] terminated in
            Task { @MainActor [weak self] in
                self?.handleTermination(terminated)
            }
        }

        self.process = proc
        self.logHandle = logHandle
        ownedByApp = true
        do {
            try proc.run()
        } catch {
            self.process = nil
            self.logHandle = nil
            ownedByApp = false
            try? logHandle.close()
            fail("无法启动 Companion Core：\(error.localizedDescription)")
            return false
        }

        // 等待 health ready：只要进程存活就持续轮询；
        // 进程死亡或超过硬上限才判定失败。
        let hardLimit = max(TimeInterval(waitSeconds) * 3, 45)
        let hardDeadline = Date().addingTimeInterval(hardLimit)
        while Date() < hardDeadline {
            if Task.isCancelled { return false }
            if await isHealthy() {
                phase = .running(ownedByApp: true)
                consecutiveFailures = 0
                failureMessage = nil
                scheduleStabilityReset(for: proc)
                Breadcrumb.emit("core.launch success")
                return true
            }
            if !proc.isRunning {
                fail("Companion Core 进程启动后立即退出，请查看 \(logPath)")
                return false
            }
            try? await Task.sleep(nanoseconds: 400_000_000)
        }
        stop(process: proc)
        fail("Core 在 \(Int(hardLimit))s 内未就绪")
        return false
    }

    private func handleTermination(_ terminated: Process) {
        guard process === terminated else { return }
        process = nil
        try? logHandle?.close()
        logHandle = nil

        let shouldRecover = ownedByApp
        ownedByApp = false
        stabilityTask?.cancel()
        guard shouldRecover else { return }

        // 如果已经处于恢复循环，当前启动失败会由该循环继续退避重试。
        guard recoveryTask == nil else { return }
        beginAutomaticRecovery()
    }

    private func beginAutomaticRecovery() {
        recoveryTask = Task { @MainActor [weak self] in
            guard let self else { return }
            while self.automaticRestartAttempts < self.maxConsecutiveFailures {
                self.automaticRestartAttempts += 1
                let attempt = self.automaticRestartAttempts
                let delaySeconds = 1 << (attempt - 1)
                self.phase = .failed("Candidate Core 意外退出，\(delaySeconds) 秒后自动恢复（\(attempt)/\(self.maxConsecutiveFailures)）")
                self.failureMessage = self.phase.failureDetail
                Breadcrumb.emit("core.recovery backoff #\(attempt)")

                try? await Task.sleep(nanoseconds: UInt64(delaySeconds) * 1_000_000_000)
                guard !Task.isCancelled else { return }
                if await self.ensureRunning() {
                    // 给 termination handler 一个事件循环周期来清理瞬时退出的进程。
                    try? await Task.sleep(nanoseconds: 100_000_000)
                    if case .running = self.phase {
                        self.recoveryTask = nil
                        return
                    }
                }
            }
            let message = "Candidate Core 自动恢复连续失败 \(self.maxConsecutiveFailures) 次，已停止自动拉起，请手动重试。"
            self.automaticRecoverySuppressed = true
            self.failureMessage = message
            self.phase = .failed(message)
            self.recoveryTask = nil
            Breadcrumb.emit("core.recovery stopped")
        }
    }

    private func scheduleStabilityReset(for launchedProcess: Process) {
        stabilityTask?.cancel()
        stabilityTask = Task { @MainActor [weak self, weak launchedProcess] in
            try? await Task.sleep(nanoseconds: 30_000_000_000)
            guard !Task.isCancelled,
                  let self,
                  let launchedProcess,
                  self.process === launchedProcess,
                  launchedProcess.isRunning,
                  await self.isHealthy() else { return }
            self.automaticRestartAttempts = 0
            self.automaticRecoverySuppressed = false
            Breadcrumb.emit("core.recovery stable")
        }
    }

    private func fail(_ message: String) {
        failureMessage = message
        consecutiveFailures += 1
        if consecutiveFailures >= maxConsecutiveFailures {
            phase = .failed(message + "（已连续失败 \(consecutiveFailures) 次，自动拉起停止）")
        } else {
            phase = .failed(message)
        }
        Breadcrumb.emit("core.launch failure #\(consecutiveFailures)")
    }

    public var canAutoRetry: Bool { consecutiveFailures < maxConsecutiveFailures }

    public func retry() async -> Bool {
        guard deploymentMode == .local else {
            fail("CORE_MODE=remote：本机 Core 重试已禁用。")
            return false
        }
        recoveryTask?.cancel()
        recoveryTask = nil
        stabilityTask?.cancel()
        consecutiveFailures = 0
        automaticRestartAttempts = 0
        automaticRecoverySuppressed = false
        phase = .idle
        return await ensureRunning()
    }

    /// Remote 模式必须在本机 :8770 完全停止后才能连接云端，避免双主。
    public func validateRemoteIsolation() async -> Bool {
        guard deploymentMode == .remote else { return true }
        guard !(await isHealthy()) else {
            fail("CORE_MODE=remote 与本机 :8770 冲突；请先停止本机 Candidate，再连接云端。")
            return false
        }
        phase = .running(ownedByApp: false)
        failureMessage = nil
        return true
    }

    /// Quit 时调用：只终止由本 App 拉起的实例；外部启动的保持运行
    public func stopIfOwned() {
        guard ownedByApp, let proc = process, proc.isRunning else { return }
        recoveryTask?.cancel()
        recoveryTask = nil
        stabilityTask?.cancel()
        stop(process: proc)
        Breadcrumb.emit("core owned instance terminated")
    }

    private func stop(process proc: Process) {
        ownedByApp = false
        if process === proc { process = nil }
        proc.terminate()
        let deadline = Date().addingTimeInterval(2)
        while proc.isRunning && Date() < deadline {
            Thread.sleep(forTimeInterval: 0.05)
        }
        if proc.isRunning { kill(proc.processIdentifier, SIGKILL) }
        try? logHandle?.close()
        logHandle = nil
    }
}
