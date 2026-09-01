import Foundation
import Security

enum FrpMode: String, Codable, CaseIterable, Identifiable {
    case disabled
    case externalToml
    case selfHosted

    var id: String { rawValue }
}

struct LauncherConfig: Codable, Equatable {
    var pairingCode = LauncherConfig.generatePairingCode()
    var port = 4_310
    var cdpPort = 9_341
    var allowLAN = false
    var externalPublicURL: String?
    var startOnAppLaunch = false
    var preventSystemSleepWhileRunning: Bool?
    var language: AppLanguage?

    var frpEnabled = false
    var frpMode: FrpMode?
    var frpcPath = ""
    var frpExternalConfigPath: String?
    var frpServerAddress = ""
    var frpServerPort = 7_000
    var frpClientID = ""
    var frpUser = ""
    var frpSubdomain = ""
    var frpServerName = ""
    var frpTrustedCAPath = ""
    var frpVerifyServerCertificate: Bool?
    var frpClientCertificatePath = ""
    var frpClientKeyPath = ""

    var verifiesFRPServerCertificate: Bool {
        frpVerifyServerCertificate ?? true
    }

    var tunnelMode: FrpMode {
        get { frpMode ?? (frpEnabled ? .selfHosted : .disabled) }
        set {
            frpMode = newValue
            frpEnabled = newValue == .selfHosted
        }
    }

    var hasManagedTunnel: Bool { tunnelMode != .disabled }
    var usesSelfHostedFRP: Bool { tunnelMode == .selfHosted }

    var externalFrpConfigPath: String {
        get { frpExternalConfigPath ?? "" }
        set { frpExternalConfigPath = newValue.isEmpty ? nil : newValue }
    }

    var appLanguage: AppLanguage {
        language ?? .simplifiedChinese
    }

    var preventsSystemSleepWhileRunning: Bool {
        preventSystemSleepWhileRunning ?? true
    }

    var hasExternalPublicURL: Bool {
        !(externalPublicURL?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ?? true)
    }

    static func generatePairingCode() -> String {
        let length = 8
        let alphabet = Array("ABCDEFGHJKLMNPQRSTUVWXYZ23456789")
        var bytes = [UInt8](repeating: 0, count: length)
        guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else {
            let fallback = UUID().uuidString.replacingOccurrences(of: "-", with: "").utf8
            return String(fallback.prefix(length).map { alphabet[Int($0) % alphabet.count] })
        }
        return String(bytes.map { alphabet[Int($0) % alphabet.count] })
    }

    mutating func normalize() {
        preventSystemSleepWhileRunning = preventsSystemSleepWhileRunning
        pairingCode = pairingCode.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
        externalPublicURL = externalPublicURL?.trimmingCharacters(in: .whitespacesAndNewlines)
        if externalPublicURL?.isEmpty == true { externalPublicURL = nil }
        let normalizedMode = tunnelMode
        frpMode = normalizedMode
        frpEnabled = normalizedMode == .selfHosted
        frpcPath = frpcPath.trimmingCharacters(in: .whitespacesAndNewlines)
        externalFrpConfigPath = externalFrpConfigPath.trimmingCharacters(in: .whitespacesAndNewlines)
        frpServerAddress = frpServerAddress.trimmingCharacters(in: .whitespacesAndNewlines)
        frpClientID = frpClientID.trimmingCharacters(in: .whitespacesAndNewlines)
        frpUser = frpUser.trimmingCharacters(in: .whitespacesAndNewlines)
        frpSubdomain = frpSubdomain.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        frpServerName = frpServerName.trimmingCharacters(in: .whitespacesAndNewlines)
        frpTrustedCAPath = frpTrustedCAPath.trimmingCharacters(in: .whitespacesAndNewlines)
        frpClientCertificatePath = frpClientCertificatePath.trimmingCharacters(in: .whitespacesAndNewlines)
        frpClientKeyPath = frpClientKeyPath.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    mutating func migrateLegacyPairingCode() {
        let normalized = pairingCode.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
        guard normalized.range(
            of: "^[A-Z2-9]{8,64}$",
            options: .regularExpression
        ) != nil else { return }
        pairingCode = String(normalized.prefix(8))
    }

    func validate(frpToken: String, gatewayToken: String, paths: RuntimePaths) throws {
        guard pairingCode.range(
            of: "^[A-Z2-9]{8}$",
            options: [.regularExpression, .caseInsensitive]
        ) != nil else {
            throw LauncherError.invalidConfiguration("配对码必须恰好为 8 位字母或数字 2-9")
        }
        guard (1_024...65_535).contains(port), (1_024...65_535).contains(cdpPort), port != cdpPort else {
            throw LauncherError.invalidConfiguration("服务端口和 CDP 端口必须不同，且位于 1024-65535")
        }
        if let externalPublicURL, !validExternalPublicURL(externalPublicURL) {
            throw LauncherError.invalidConfiguration("外部 HTTPS 地址必须是不含路径、参数或凭据的完整 HTTPS 地址")
        }
        guard hasManagedTunnel else { return }

        let binary = frpcPath.isEmpty ? paths.bundledFrpc.path : frpcPath
        guard FileManager.default.isExecutableFile(atPath: binary) else {
            throw LauncherError.invalidConfiguration("找不到可执行的 frpc")
        }

        if tunnelMode == .externalToml {
            guard hasExternalPublicURL else {
                throw LauncherError.invalidConfiguration("通用 TOML 模式必须填写外部 HTTPS 地址")
            }
            guard privateRegularFile(atPath: externalFrpConfigPath) else {
                throw LauncherError.invalidConfiguration("请选择权限不高于 0600 的 FRP TOML 文件")
            }
            return
        }

        guard validHostname(frpServerAddress) else {
            throw LauncherError.invalidConfiguration("FRP 地址必须是有效主机名或 IP")
        }
        guard (1...65_535).contains(frpServerPort) else {
            throw LauncherError.invalidConfiguration("FRP 端口必须位于 1-65535")
        }
        guard validIdentifier(frpClientID), validIdentifier(frpUser) else {
            throw LauncherError.invalidConfiguration("设备 ID 和用户只能包含字母、数字、点、下划线或连字符")
        }
        guard frpSubdomain.range(of: "^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$", options: .regularExpression) != nil else {
            throw LauncherError.invalidConfiguration("FRP 子域必须是小写 DNS 标签")
        }
        if verifiesFRPServerCertificate {
            guard validHostname(frpServerName) else {
                throw LauncherError.invalidConfiguration("证书名称必须是有效主机名或 IP")
            }
            guard FileManager.default.isReadableFile(atPath: frpTrustedCAPath) else {
                throw LauncherError.invalidConfiguration("请选择可读取的 FRP CA 证书")
            }
        }
        guard (8...512).contains(frpToken.unicodeScalars.count),
              (8...512).contains(gatewayToken.unicodeScalars.count) else {
            throw LauncherError.invalidConfiguration("FRP token 和网关 token 均须为 8-512 个字符")
        }
        guard frpClientCertificatePath.isEmpty == frpClientKeyPath.isEmpty else {
            throw LauncherError.invalidConfiguration("mTLS 客户端证书和私钥必须同时设置")
        }
        if !frpClientCertificatePath.isEmpty {
            guard FileManager.default.isReadableFile(atPath: frpClientCertificatePath),
                  FileManager.default.isReadableFile(atPath: frpClientKeyPath) else {
                throw LauncherError.invalidConfiguration("mTLS 客户端证书或私钥不可读取")
            }
        }
    }

    private func validIdentifier(_ value: String) -> Bool {
        value.range(of: "^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$", options: .regularExpression) != nil
    }

    private func validHostname(_ value: String) -> Bool {
        guard !value.isEmpty, value.count <= 253, !value.contains("://"), !value.contains("/") else { return false }
        return value.split(separator: ".").allSatisfy { label in
            label.range(of: "^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$", options: .regularExpression) != nil
        }
    }

    private func validExternalPublicURL(_ value: String) -> Bool {
        guard let components = URLComponents(string: value),
              components.scheme?.lowercased() == "https",
              components.host?.isEmpty == false,
              components.user == nil,
              components.password == nil,
              components.path.isEmpty || components.path == "/",
              components.query == nil,
              components.fragment == nil,
              components.url != nil else { return false }
        return true
    }

    private func privateRegularFile(atPath path: String) -> Bool {
        guard !path.isEmpty,
              let attributes = try? FileManager.default.attributesOfItem(atPath: path),
              attributes[.type] as? FileAttributeType == .typeRegular,
              let permissions = attributes[.posixPermissions] as? NSNumber else { return false }
        return permissions.intValue & 0o077 == 0
    }
}

enum LauncherError: LocalizedError {
    case invalidConfiguration(String)
    case missingResource(String)
    case processFailed(String)
    case healthCheckFailed(String)

    var errorDescription: String? {
        switch self {
        case .invalidConfiguration(let detail), .missingResource(let detail),
             .processFailed(let detail), .healthCheckFailed(let detail):
            return detail
        }
    }
}

struct RuntimePaths {
    let supportDirectory: URL
    let configFile: URL
    let secretsDirectory: URL
    let frpTokenFile: URL
    let gatewayTokenFile: URL
    let resourceRoot: URL

    var node: URL { resourceRoot.appendingPathComponent("runtime/node") }
    var server: URL { resourceRoot.appendingPathComponent("app/dist/server/server.js") }
    var appWorkingDirectory: URL { resourceRoot.appendingPathComponent("app") }
    var captureBinary: URL {
        resourceRoot.appendingPathComponent("My Remote Codex Capture.app/Contents/MacOS/remote-codex-capture")
    }
    var launchCodexScript: URL { resourceRoot.appendingPathComponent("scripts/launch-codex-macos.sh") }
    var bundledFrpc: URL { resourceRoot.appendingPathComponent("runtime/frpc") }

    static func current() -> RuntimePaths {
        let manager = FileManager.default
        let support = manager.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("My Remote Codex", isDirectory: true)
        let configuredRoot = ProcessInfo.processInfo.environment["MY_REMOTE_CODEX_RESOURCE_ROOT"]
            .map { URL(fileURLWithPath: $0, isDirectory: true) }
        let resources = configuredRoot ?? Bundle.main.resourceURL ?? URL(fileURLWithPath: manager.currentDirectoryPath)
        let secrets = support.appendingPathComponent("secrets", isDirectory: true)
        return RuntimePaths(
            supportDirectory: support,
            configFile: support.appendingPathComponent("config.json"),
            secretsDirectory: secrets,
            frpTokenFile: secrets.appendingPathComponent("frp-token"),
            gatewayTokenFile: secrets.appendingPathComponent("gateway-token"),
            resourceRoot: resources
        )
    }
}
