import Foundation

enum AppLanguage: String, Codable, CaseIterable, Identifiable {
    case simplifiedChinese = "zh-Hans"
    case english = "en"

    var id: String { rawValue }
}

struct BilingualText: Equatable {
    let chinese: String
    let english: String

    init(_ chinese: String, _ english: String) {
        self.chinese = chinese
        self.english = english
    }

    init(canonicalChinese: String) {
        chinese = canonicalChinese
        english = DesktopI18n.english(for: canonicalChinese)
    }

    func resolved(for language: AppLanguage) -> String {
        language == .english ? english : chinese
    }
}

enum DesktopI18n {
    static func text(_ chinese: String, _ english: String, language: AppLanguage) -> String {
        language == .english ? english : chinese
    }

    static func english(for chinese: String) -> String {
        if let exact = englishTranslations[chinese] { return exact }

        let patterns: [(String, String)] = [
            ("服务异常退出（", "Service exited unexpectedly ("),
            ("状态接口返回 HTTP ", "Status endpoint returned HTTP "),
            ("本机状态会话创建失败（HTTP ", "Failed to create a local status session (HTTP "),
        ]
        for (prefix, replacement) in patterns where chinese.hasPrefix(prefix) {
            return replacement + chinese.dropFirst(prefix.count)
                .replacingOccurrences(of: "）", with: ")")
        }
        return chinese
    }

    private static let englishTranslations: [String: String] = [
        "配置完成后启动服务": "Configure the app, then start the service",
        "配置已保存": "Configuration saved",
        "正在检查运行环境": "Checking the runtime environment",
        "正在以远程调试模式启动 Codex": "Starting Codex in remote debugging mode",
        "本机服务与 FRP 隧道已启动": "Local service and FRP tunnel started",
        "本机服务已启动": "Local service started",
        "正在停止服务": "Stopping the service",
        "正在执行连接测试": "Running connection tests",
        "运行环境正常，请先启动服务再测试连接": "The runtime is ready. Start the service before testing the connection.",
        "连接测试完成": "Connection tests completed",
        "所选文件不可执行": "The selected file is not executable",
        "安装包缺少 Node.js 运行时": "The app bundle is missing the Node.js runtime",
        "安装包缺少服务端程序": "The app bundle is missing the server program",
        "安装包缺少原生视频采集器": "The app bundle is missing the native video capture helper",
        "安装包缺少 Codex 启动脚本": "The app bundle is missing the Codex launch script",
        "服务已停止": "Service stopped",
        "Codex 已启动，但 CDP 端口尚不可用": "Codex started, but the CDP port is not available yet",
        "本机服务未能在 8 秒内通过健康检查": "The local service did not pass its health check within 8 seconds",
        "FRP 启动失败，请查看运行日志": "FRP failed to start. Check the runtime log.",
        "FRP 隧道未能在 10 秒内进入运行状态": "The FRP tunnel did not start within 10 seconds",
        "无法读取连接测试响应": "Could not read the connection test response",
        "配对码必须恰好为 8 位字母或数字 2-9": "The pairing code must contain exactly 8 letters or digits 2-9",
        "服务端口和 CDP 端口必须不同，且位于 1024-65535": "The service and CDP ports must differ and be between 1024 and 65535",
        "外部 HTTPS 地址必须是不含路径、参数或凭据的完整 HTTPS 地址": "The external HTTPS URL must be a complete HTTPS origin without a path, query, or credentials",
        "FRP 地址必须是有效主机名或 IP": "The FRP address must be a valid hostname or IP address",
        "FRP 端口必须位于 1-65535": "The FRP port must be between 1 and 65535",
        "设备 ID 和用户只能包含字母、数字、点、下划线或连字符": "Device ID and user may contain only letters, numbers, dots, underscores, or hyphens",
        "FRP 子域必须是小写 DNS 标签": "The FRP subdomain must be a lowercase DNS label",
        "证书名称必须是有效主机名或 IP": "The certificate name must be a valid hostname or IP address",
        "请选择可读取的 FRP CA 证书": "Select a readable FRP CA certificate",
        "找不到可执行的 frpc": "Could not find an executable frpc binary",
        "通用 TOML 模式必须填写外部 HTTPS 地址": "External TOML mode requires a public HTTPS address",
        "请选择当前用户拥有且可读取的 FRP TOML 普通文件": "Select a readable regular FRP TOML file owned by the current user",
        "FRP token 和网关 token 均须为 8-512 个字符": "The FRP and gateway tokens must each contain 8-512 characters",
        "mTLS 客户端证书和私钥必须同时设置": "The mTLS client certificate and private key must be configured together",
        "mTLS 客户端证书或私钥不可读取": "The mTLS client certificate or private key is not readable",
    ]
}
