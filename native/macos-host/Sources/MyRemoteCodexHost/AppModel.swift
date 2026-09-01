import AppKit
import Combine
import Darwin
import Foundation

enum RuntimePhase {
    case stopped
    case starting
    case running
    case stopping
    case failed

    var label: BilingualText {
        switch self {
        case .stopped: return BilingualText("已停止", "Stopped")
        case .starting: return BilingualText("启动中", "Starting")
        case .running: return BilingualText("运行中", "Running")
        case .stopping: return BilingualText("停止中", "Stopping")
        case .failed: return BilingualText("异常", "Failed")
        }
    }
}

@MainActor
final class AppModel: ObservableObject {
    @Published var config: LauncherConfig
    @Published var frpToken = ""
    @Published var gatewayToken = ""
    @Published private(set) var servicePhase: RuntimePhase = .stopped
    @Published private(set) var cdpStatus = BilingualText("未检测", "Not checked")
    @Published private(set) var frpStatus = BilingualText("未启用", "Disabled")
    @Published private(set) var message = BilingualText("配置完成后启动服务", "Configure the app, then start the service")
    @Published private(set) var logs = ""
    @Published private(set) var isBusy = false

    let paths: RuntimePaths
    private var serverProcess: Process?
    private var logPipe: Pipe?
    private var systemSleepActivity: NSObjectProtocol?
    private var booted = false

    init(paths: RuntimePaths = .current()) {
        _ = umask(S_IRWXG | S_IRWXO)
        self.paths = paths
        if let data = try? Data(contentsOf: paths.configFile),
           let stored = try? JSONDecoder().decode(LauncherConfig.self, from: data) {
            var migrated = stored
            migrated.migrateLegacyPairingCode()
            config = migrated
        } else {
            config = LauncherConfig()
        }
        frpToken = (try? String(contentsOf: paths.frpTokenFile, encoding: .utf8))?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        gatewayToken = (try? String(contentsOf: paths.gatewayTokenFile, encoding: .utf8))?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    }

    var localURL: URL { URL(string: "http://127.0.0.1:\(config.port)")! }
    var externalPublicURL: URL? {
        guard let value = config.externalPublicURL else { return nil }
        return URL(string: value)
    }
    var isRunning: Bool { serverProcess?.isRunning == true }

    func text(_ chinese: String, _ english: String) -> String {
        DesktopI18n.text(chinese, english, language: config.appLanguage)
    }

    func display(_ value: BilingualText) -> String {
        value.resolved(for: config.appLanguage)
    }

    func boot() {
        guard !booted else { return }
        booted = true
        if config.startOnAppLaunch {
            Task { await start() }
        }
    }

    func generatePairingCode() {
        config.pairingCode = LauncherConfig.generatePairingCode()
    }

    func setPreventSystemSleepWhileRunning(_ enabled: Bool) {
        config.preventSystemSleepWhileRunning = enabled
        updateSystemSleepPrevention()
    }

    func save() throws {
        config.normalize()
        try config.validate(frpToken: frpToken, gatewayToken: gatewayToken, paths: paths)
        let manager = FileManager.default
        try manager.createDirectory(at: paths.supportDirectory, withIntermediateDirectories: true)
        try manager.createDirectory(at: paths.secretsDirectory, withIntermediateDirectories: true)
        try manager.setAttributes([.posixPermissions: 0o700], ofItemAtPath: paths.supportDirectory.path)
        try manager.setAttributes([.posixPermissions: 0o700], ofItemAtPath: paths.secretsDirectory.path)

        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        try writePrivate(try encoder.encode(config), to: paths.configFile)
        if !frpToken.isEmpty { try writePrivate(Data(frpToken.utf8), to: paths.frpTokenFile) }
        if !gatewayToken.isEmpty { try writePrivate(Data(gatewayToken.utf8), to: paths.gatewayTokenFile) }
        message = BilingualText("配置已保存", "Configuration saved")
    }

    func saveConfiguration() {
        do {
            try save()
        } catch {
            message = BilingualText(canonicalChinese: error.localizedDescription)
        }
    }

    func start() async {
        guard !isBusy, !isRunning else { return }
        isBusy = true
        servicePhase = .starting
        message = BilingualText("正在检查运行环境", "Checking the runtime environment")
        defer { isBusy = false }
        do {
            try save()
            try requireResources()
            if !(await cdpReachable()) {
                message = BilingualText("正在以远程调试模式启动 Codex", "Starting Codex in remote debugging mode")
                try await launchCodex()
            }
            try spawnServer()
            updateSystemSleepPrevention()
            try await waitForLocalHealth()
            try await refreshRuntimeStatus(waitForFRP: config.frpEnabled)
            servicePhase = .running
            message = config.frpEnabled
                ? BilingualText("本机服务与 FRP 隧道已启动", "Local service and FRP tunnel started")
                : BilingualText("本机服务已启动", "Local service started")
        } catch {
            stopImmediately()
            servicePhase = .failed
            message = BilingualText(canonicalChinese: error.localizedDescription)
            appendLog("[host] \(error.localizedDescription)\n")
        }
    }

    func stop() {
        guard let process = serverProcess else {
            endSystemSleepPrevention()
            servicePhase = .stopped
            return
        }
        servicePhase = .stopping
        message = BilingualText("正在停止服务", "Stopping the service")
        process.terminate()
    }

    func restart() async {
        stop()
        for _ in 0..<30 where isRunning {
            try? await Task.sleep(nanoseconds: 100_000_000)
        }
        await start()
    }

    func runDiagnostics() async {
        guard !isBusy else { return }
        isBusy = true
        message = BilingualText("正在执行连接测试", "Running connection tests")
        defer { isBusy = false }
        do {
            try requireResources()
            cdpStatus = await cdpReachable()
                ? BilingualText("已连接", "Connected")
                : BilingualText("未连接", "Disconnected")
            guard isRunning else {
                frpStatus = config.frpEnabled
                    ? BilingualText("服务未启动", "Service not started")
                    : BilingualText("未启用", "Disabled")
                throw LauncherError.healthCheckFailed("运行环境正常，请先启动服务再测试连接")
            }
            try await waitForLocalHealth()
            try await refreshRuntimeStatus(waitForFRP: false)
            message = BilingualText("连接测试完成", "Connection tests completed")
        } catch {
            message = BilingualText(canonicalChinese: error.localizedDescription)
        }
    }

    func openLocalPage() {
        NSWorkspace.shared.open(localURL)
    }

    func openExternalPage() {
        if let externalPublicURL { NSWorkspace.shared.open(externalPublicURL) }
    }

    func chooseFile(title: String, executable: Bool = false, apply: (String) -> Void) {
        let panel = NSOpenPanel()
        panel.title = title
        panel.canChooseDirectories = false
        panel.canChooseFiles = true
        panel.allowsMultipleSelection = false
        panel.resolvesAliases = true
        if panel.runModal() == .OK, let url = panel.url {
            if executable && !FileManager.default.isExecutableFile(atPath: url.path) {
                message = BilingualText("所选文件不可执行", "The selected file is not executable")
                return
            }
            apply(url.path)
        }
    }

    func applicationWillTerminate() {
        stopImmediately()
    }

    private func requireResources() throws {
        let required = [
            (paths.node, "安装包缺少 Node.js 运行时"),
            (paths.server, "安装包缺少服务端程序"),
            (paths.captureBinary, "安装包缺少原生视频采集器"),
            (paths.launchCodexScript, "安装包缺少 Codex 启动脚本"),
        ]
        for (url, error) in required where !FileManager.default.isExecutableFile(atPath: url.path)
            && url != paths.server {
            throw LauncherError.missingResource(error)
        }
        guard FileManager.default.isReadableFile(atPath: paths.server.path) else {
            throw LauncherError.missingResource("安装包缺少服务端程序")
        }
    }

    private func spawnServer() throws {
        let process = Process()
        process.executableURL = paths.node
        process.arguments = [paths.server.path]
        process.currentDirectoryURL = paths.appWorkingDirectory
        process.environment = serverEnvironment()
        let pipe = Pipe()
        pipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            guard !data.isEmpty else { return }
            let text = String(decoding: data, as: UTF8.self)
            DispatchQueue.main.async { self?.appendLog(text) }
        }
        process.standardOutput = pipe
        process.standardError = pipe
        process.terminationHandler = { [weak self] child in
            DispatchQueue.main.async {
                guard let self, self.serverProcess === child else { return }
                self.logPipe?.fileHandleForReading.readabilityHandler = nil
                self.logPipe = nil
                self.serverProcess = nil
                self.endSystemSleepPrevention()
                self.servicePhase = child.terminationStatus == 0 ? .stopped : .failed
                self.frpStatus = self.config.frpEnabled
                    ? BilingualText("已停止", "Stopped")
                    : BilingualText("未启用", "Disabled")
                self.message = child.terminationStatus == 0
                    ? BilingualText("服务已停止", "Service stopped")
                    : BilingualText(
                        "服务异常退出（\(child.terminationStatus)）",
                        "Service exited unexpectedly (\(child.terminationStatus))"
                    )
            }
        }
        try process.run()
        serverProcess = process
        logPipe = pipe
    }

    private func serverEnvironment() -> [String: String] {
        var environment = ProcessInfo.processInfo.environment
        let usesTunnel = config.frpEnabled || config.hasExternalPublicURL
        environment["REMOTE_CODEX_HOST"] = usesTunnel ? "127.0.0.1" : (config.allowLAN ? "0.0.0.0" : "127.0.0.1")
        environment["REMOTE_CODEX_ALLOW_INSECURE_HTTP"] = config.allowLAN && !usesTunnel ? "true" : "false"
        environment["REMOTE_CODEX_PORT"] = String(config.port)
        environment["REMOTE_CODEX_CDP_PORT"] = String(config.cdpPort)
        environment["REMOTE_CODEX_PAIRING_CODE"] = config.pairingCode
        environment["REMOTE_CODEX_NATIVE_CAPTURE_BINARY"] = paths.captureBinary.path
        environment["REMOTE_CODEX_VIDEO_TRANSPORT"] = "auto"
        environment["REMOTE_CODEX_FRP_ENABLED"] = config.frpEnabled ? "true" : "false"
        if let externalPublicURL = config.externalPublicURL {
            environment["REMOTE_CODEX_PUBLIC_ORIGIN"] = externalPublicURL
        } else {
            environment.removeValue(forKey: "REMOTE_CODEX_PUBLIC_ORIGIN")
        }
        guard config.frpEnabled else { return environment }

        environment["REMOTE_CODEX_FRP_BINARY"] = config.frpcPath.isEmpty ? paths.bundledFrpc.path : config.frpcPath
        environment["REMOTE_CODEX_FRP_SERVER_ADDR"] = config.frpServerAddress
        environment["REMOTE_CODEX_FRP_SERVER_PORT"] = String(config.frpServerPort)
        environment["REMOTE_CODEX_FRP_CLIENT_ID"] = config.frpClientID
        environment["REMOTE_CODEX_FRP_USER"] = config.frpUser
        environment["REMOTE_CODEX_FRP_SUBDOMAIN"] = config.frpSubdomain
        environment["REMOTE_CODEX_FRP_TOKEN_FILE"] = paths.frpTokenFile.path
        environment["REMOTE_CODEX_FRP_GATEWAY_TOKEN_FILE"] = paths.gatewayTokenFile.path
        environment["REMOTE_CODEX_FRP_VERIFY_SERVER"] = config.verifiesFRPServerCertificate ? "true" : "false"
        if config.verifiesFRPServerCertificate {
            environment["REMOTE_CODEX_FRP_TRUSTED_CA"] = config.frpTrustedCAPath
            environment["REMOTE_CODEX_FRP_SERVER_NAME"] = config.frpServerName
        } else {
            environment.removeValue(forKey: "REMOTE_CODEX_FRP_TRUSTED_CA")
            environment.removeValue(forKey: "REMOTE_CODEX_FRP_SERVER_NAME")
        }
        environment["REMOTE_CODEX_SECURE_COOKIE"] = "true"
        if !config.frpClientCertificatePath.isEmpty {
            environment["REMOTE_CODEX_FRP_CLIENT_CERT"] = config.frpClientCertificatePath
            environment["REMOTE_CODEX_FRP_CLIENT_KEY"] = config.frpClientKeyPath
        }
        return environment
    }

    private func launchCodex() async throws {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/bash")
        process.arguments = [paths.launchCodexScript.path]
        var environment = ProcessInfo.processInfo.environment
        environment["REMOTE_CODEX_CDP_PORT"] = String(config.cdpPort)
        process.environment = environment
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = pipe
        try process.run()
        await Task.detached { process.waitUntilExit() }.value
        let output = String(decoding: pipe.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
        appendLog(output)
        guard process.terminationStatus == 0 else {
            throw LauncherError.processFailed(output.trimmingCharacters(in: .whitespacesAndNewlines))
        }
        for _ in 0..<50 {
            if await cdpReachable() { return }
            try? await Task.sleep(nanoseconds: 100_000_000)
        }
        throw LauncherError.healthCheckFailed("Codex 已启动，但 CDP 端口尚不可用")
    }

    private func waitForLocalHealth() async throws {
        let url = localURL.appendingPathComponent("healthz")
        for _ in 0..<80 {
            if let (_, response) = try? await request(url), response.statusCode == 200 { return }
            if serverProcess?.isRunning != true { break }
            try? await Task.sleep(nanoseconds: 100_000_000)
        }
        throw LauncherError.healthCheckFailed("本机服务未能在 8 秒内通过健康检查")
    }

    private func cdpReachable() async -> Bool {
        guard let url = URL(string: "http://127.0.0.1:\(config.cdpPort)/json/version") else { return false }
        guard let (_, response) = try? await request(url, timeout: 1) else { return false }
        return response.statusCode == 200
    }

    private func refreshRuntimeStatus(waitForFRP: Bool) async throws {
        let url = localURL.appendingPathComponent("api/session")
        let attempts = waitForFRP ? 100 : 1
        let headers = try await createLocalSession()
        for index in 0..<attempts {
            let (data, response) = try await request(url, headers: headers)
            guard response.statusCode == 200 else {
                throw LauncherError.healthCheckFailed("状态接口返回 HTTP \(response.statusCode)")
            }
            let state = try JSONDecoder().decode(SessionState.self, from: data)
            cdpStatus = state.mirror.phase == "connected"
                ? BilingualText("已连接", "Connected")
                : localizedPhase(state.mirror.phase)
            frpStatus = config.frpEnabled
                ? localizedPhase(state.tunnel.phase)
                : BilingualText("未启用", "Disabled")
            if !waitForFRP || state.tunnel.phase == "running" { return }
            if state.tunnel.phase == "failed" {
                throw LauncherError.healthCheckFailed("FRP 启动失败，请查看运行日志")
            }
            if index + 1 < attempts { try? await Task.sleep(nanoseconds: 100_000_000) }
        }
        throw LauncherError.healthCheckFailed("FRP 隧道未能在 10 秒内进入运行状态")
    }

    private func createLocalSession() async throws -> [String: String] {
        var headers = [
            "Content-Type": "application/json",
            "Origin": localURL.absoluteString,
        ]
        if config.frpEnabled { headers["x-remote-codex-gateway-token"] = gatewayToken }
        let body = try JSONEncoder().encode(PairRequest(code: config.pairingCode))
        let (_, response) = try await request(
            localURL.appendingPathComponent("api/pair"),
            headers: headers,
            method: "POST",
            body: body
        )
        guard response.statusCode == 200,
              let cookie = response.value(forHTTPHeaderField: "Set-Cookie")?.split(separator: ";").first else {
            throw LauncherError.healthCheckFailed("本机状态会话创建失败（HTTP \(response.statusCode)）")
        }
        headers.removeValue(forKey: "Content-Type")
        headers.removeValue(forKey: "Origin")
        headers["Cookie"] = String(cookie)
        return headers
    }

    private func request(
        _ url: URL,
        headers: [String: String] = [:],
        method: String = "GET",
        body: Data? = nil,
        timeout: TimeInterval = 2
    ) async throws -> (Data, HTTPURLResponse) {
        var request = URLRequest(url: url, timeoutInterval: timeout)
        request.httpMethod = method
        request.httpBody = body
        headers.forEach { request.setValue($0.value, forHTTPHeaderField: $0.key) }
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw LauncherError.healthCheckFailed("无法读取连接测试响应")
        }
        return (data, http)
    }

    private func writePrivate(_ data: Data, to url: URL) throws {
        try data.write(to: url, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
    }

    private func localizedPhase(_ phase: String) -> BilingualText {
        switch phase {
        case "stopped": return BilingualText("已停止", "Stopped")
        case "starting": return BilingualText("启动中", "Starting")
        case "running": return BilingualText("运行中", "Running")
        case "stopping": return BilingualText("停止中", "Stopping")
        case "failed": return BilingualText("异常", "Failed")
        case "connected": return BilingualText("已连接", "Connected")
        case "disconnected": return BilingualText("未连接", "Disconnected")
        case "discovering": return BilingualText("检测中", "Discovering")
        default: return BilingualText(phase, phase)
        }
    }

    private func stopImmediately() {
        logPipe?.fileHandleForReading.readabilityHandler = nil
        logPipe = nil
        if let process = serverProcess, process.isRunning { process.terminate() }
        serverProcess = nil
        endSystemSleepPrevention()
    }

    private func updateSystemSleepPrevention() {
        let shouldPreventSleep = isRunning && config.preventsSystemSleepWhileRunning
        if shouldPreventSleep, systemSleepActivity == nil {
            systemSleepActivity = ProcessInfo.processInfo.beginActivity(
                options: [.userInitiated, .idleSystemSleepDisabled],
                reason: "My Remote Codex service is running"
            )
        } else if !shouldPreventSleep {
            endSystemSleepPrevention()
        }
    }

    private func endSystemSleepPrevention() {
        guard let activity = systemSleepActivity else { return }
        ProcessInfo.processInfo.endActivity(activity)
        systemSleepActivity = nil
    }

    private func appendLog(_ text: String) {
        logs.append(text)
        if logs.count > 30_000 { logs.removeFirst(logs.count - 30_000) }
    }
}

private struct SessionState: Decodable {
    struct Phase: Decodable { let phase: String }
    let mirror: Phase
    let tunnel: Phase
}

private struct PairRequest: Encodable {
    let code: String
}
