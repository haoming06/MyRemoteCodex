import SwiftUI

struct ContentView: View {
    @ObservedObject var model: AppModel
    @State private var externalOriginHelpHovered = false
    @State private var externalOriginHelpPinned = false

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider()
            TabView {
                generalSettings
                    .tabItem { Label(model.text("常规", "General"), systemImage: "gearshape") }
                frpSettings
                    .tabItem { Label("FRP", systemImage: "network") }
                diagnostics
                    .tabItem { Label(model.text("诊断", "Diagnostics"), systemImage: "stethoscope") }
            }
            .padding(.horizontal, 20)
            Divider()
            footer
        }
        .frame(minWidth: 720, idealWidth: 760, minHeight: 590, idealHeight: 640)
        .onAppear { model.boot() }
    }

    private var header: some View {
        HStack(spacing: 12) {
            Image(systemName: "rectangle.connected.to.line.below")
                .font(.system(size: 27, weight: .medium))
                .foregroundStyle(.tint)
                .frame(width: 38, height: 38)
            VStack(alignment: .leading, spacing: 2) {
                Text("My Remote Codex")
                    .font(.title2.weight(.semibold))
                Text(model.display(model.message))
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            Spacer()
            statusLabel(model.servicePhase)
        }
        .padding(20)
    }

    private var generalSettings: some View {
        Form {
            Section(model.text("语言", "Language")) {
                Picker(model.text("界面语言", "Interface language"), selection: appLanguage) {
                    Text("中文").tag(AppLanguage.simplifiedChinese)
                    Text("English").tag(AppLanguage.english)
                }
                .pickerStyle(.segmented)
            }

            Section(model.text("访问", "Access")) {
                LabeledContent(model.text("配对码", "Pairing code")) {
                    HStack(spacing: 8) {
                        TextField(
                            "",
                            text: $model.config.pairingCode,
                            prompt: Text(model.text("8 位配对码", "8-character code"))
                        )
                            .labelsHidden()
                            .accessibilityLabel(model.text("配对码", "Pairing code"))
                            .textFieldStyle(.roundedBorder)
                            .font(.system(.body, design: .monospaced))
                            .frame(width: 160)
                        Button(action: model.generatePairingCode) {
                            Image(systemName: "arrow.clockwise")
                        }
                        .help(model.text("重新生成配对码", "Generate a new pairing code"))
                    }
                }
                Toggle(model.text("允许可信局域网设备访问", "Allow trusted devices on the local network"), isOn: $model.config.allowLAN)
                    .disabled(model.config.frpEnabled || model.config.hasExternalPublicURL)
                HStack(spacing: 12) {
                    HStack(spacing: 5) {
                        Text(model.text("授权的外部 HTTPS 来源", "Allowed external HTTPS origin"))
                        Button {
                            externalOriginHelpPinned.toggle()
                        } label: {
                            Image(systemName: "questionmark.circle")
                                .foregroundStyle(.secondary)
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel(model.text("配置说明", "Configuration help"))
                        .onHover { externalOriginHelpHovered = $0 }
                        .popover(isPresented: externalOriginHelpPresented, arrowEdge: .bottom) {
                            Text(model.text(
                                "仅当使用独立运行的 HTTPS 隧道或反向代理访问本机服务时填写最终生成的公网地址；使用本机、局域网或应用内置 FRP 时留空。",
                                "Enter the generated public URL only when an independently managed HTTPS tunnel or reverse proxy accesses the local service. Leave it empty for local, LAN, or built-in FRP access."
                            ))
                            .frame(width: 320, alignment: .leading)
                            .fixedSize(horizontal: false, vertical: true)
                            .padding(12)
                        }
                    }
                    .fixedSize(horizontal: true, vertical: false)
                    Spacer(minLength: 8)
                    TextField("", text: externalPublicURL, axis: .horizontal)
                        .labelsHidden()
                        .accessibilityLabel(model.text("授权的外部 HTTPS 来源", "Allowed external HTTPS origin"))
                        .textFieldStyle(.roundedBorder)
                        .lineLimit(1)
                        .frame(minWidth: 240, maxWidth: .infinity, minHeight: 24, maxHeight: 24)
                        .layoutPriority(1)
                }
                Toggle(model.text("打开应用时自动启动服务", "Start the service when the app opens"), isOn: $model.config.startOnAppLaunch)
                Toggle(
                    model.text("服务运行时防止 Mac 自动休眠", "Prevent automatic sleep while the service is running"),
                    isOn: preventSystemSleepWhileRunning
                )
            }

            Section(model.text("端口", "Ports")) {
                LabeledContent(model.text("网页服务", "Web service")) {
                    TextField("4310", value: $model.config.port, format: .number)
                        .textFieldStyle(.roundedBorder)
                        .frame(width: 110)
                }
                LabeledContent("Codex CDP") {
                    TextField("9341", value: $model.config.cdpPort, format: .number)
                        .textFieldStyle(.roundedBorder)
                        .frame(width: 110)
                }
                LabeledContent(model.text("本机地址", "Local address")) {
                    Text(model.localURL.absoluteString)
                        .foregroundStyle(.secondary)
                        .textSelection(.enabled)
                }
            }
        }
        .formStyle(.grouped)
    }

    private var frpSettings: some View {
        Form {
            Section {
                Toggle(model.text("启用 FRP 自托管隧道", "Enable the self-hosted FRP tunnel"), isOn: $model.config.frpEnabled)
            }

            Section(model.text("服务器", "Server"), content: {
                textRow(model.text("FRP 地址", "FRP address"), text: $model.config.frpServerAddress, placeholder: "frp.example.com")
                numberRow(model.text("端口", "Port"), value: $model.config.frpServerPort, placeholder: "7000")
                Picker(model.text("TLS 验证", "TLS verification"), selection: verifyFRPServerCertificate) {
                    Text(model.text("验证服务器", "Verify server")).tag(true)
                    Text(model.text("兼容（不验证）", "Compatible (no verification)")).tag(false)
                }
                .pickerStyle(.segmented)
                textRow(model.text("证书名称", "Certificate name"), text: $model.config.frpServerName, placeholder: "frp.example.com")
                    .disabled(!model.config.verifiesFRPServerCertificate)
                fileRow(model.text("CA 证书", "CA certificate"), text: $model.config.frpTrustedCAPath, title: model.text("选择 FRP CA 证书", "Select the FRP CA certificate"))
                    .disabled(!model.config.verifiesFRPServerCertificate)
                fileRow("frpc", text: $model.config.frpcPath, title: model.text("选择 frpc v0.71.0", "Select frpc v0.71.0"), executable: true, placeholder: model.text("留空使用安装包内置版本", "Leave empty to use the bundled version"))
            })
            .disabled(!model.config.frpEnabled)

            Section(model.text("设备", "Device"), content: {
                textRow(model.text("设备 ID", "Device ID"), text: $model.config.frpClientID, placeholder: "device_01")
                textRow(model.text("用户", "User"), text: $model.config.frpUser, placeholder: "account_01")
                textRow(model.text("子域", "Subdomain"), text: $model.config.frpSubdomain, placeholder: "device-01")
                secureRow("FRP token", text: $model.frpToken)
                secureRow(model.text("网关 token", "Gateway token"), text: $model.gatewayToken)
            })
            .disabled(!model.config.frpEnabled)

            Section(model.text("可选 mTLS", "Optional mTLS"), content: {
                fileRow(model.text("客户端证书", "Client certificate"), text: $model.config.frpClientCertificatePath, title: model.text("选择 mTLS 客户端证书", "Select the mTLS client certificate"))
                fileRow(model.text("客户端私钥", "Client private key"), text: $model.config.frpClientKeyPath, title: model.text("选择 mTLS 客户端私钥", "Select the mTLS client private key"))
            })
            .disabled(!model.config.frpEnabled)
        }
        .formStyle(.grouped)
    }

    private var verifyFRPServerCertificate: Binding<Bool> {
        Binding(
            get: { model.config.verifiesFRPServerCertificate },
            set: { model.config.frpVerifyServerCertificate = $0 }
        )
    }

    private var appLanguage: Binding<AppLanguage> {
        Binding(
            get: { model.config.appLanguage },
            set: { model.config.language = $0 }
        )
    }

    private var preventSystemSleepWhileRunning: Binding<Bool> {
        Binding(
            get: { model.config.preventsSystemSleepWhileRunning },
            set: { model.setPreventSystemSleepWhileRunning($0) }
        )
    }

    private var externalPublicURL: Binding<String> {
        Binding(
            get: { model.config.externalPublicURL ?? "" },
            set: { model.config.externalPublicURL = $0 }
        )
    }

    private var externalOriginHelpPresented: Binding<Bool> {
        Binding(
            get: { externalOriginHelpHovered || externalOriginHelpPinned },
            set: { presented in
                if !presented {
                    externalOriginHelpHovered = false
                    externalOriginHelpPinned = false
                }
            }
        )
    }

    private var diagnostics: some View {
        VStack(alignment: .leading, spacing: 16) {
            Grid(alignment: .leading, horizontalSpacing: 24, verticalSpacing: 10) {
                diagnosticRow(model.text("本机服务", "Local service"), value: model.servicePhase.label, phase: model.servicePhase)
                diagnosticRow("Codex CDP", value: model.cdpStatus)
                diagnosticRow(model.text("FRP 隧道", "FRP tunnel"), value: model.frpStatus)
            }
            HStack {
                Button {
                    Task { await model.runDiagnostics() }
                } label: {
                    Label(model.text("连接测试", "Test connection"), systemImage: "waveform.path.ecg")
                }
                .disabled(model.isBusy)
                Button(action: model.openLocalPage) {
                    Label(model.text("打开本机页面", "Open local page"), systemImage: "safari")
                }
                .disabled(model.servicePhase != .running)
                if model.externalPublicURL != nil {
                    Button(action: model.openExternalPage) {
                        Label(model.text("打开公网页面", "Open public page"), systemImage: "globe")
                    }
                    .disabled(model.servicePhase != .running)
                }
                if model.isBusy { ProgressView().controlSize(.small) }
            }
            Text(model.text("运行日志", "Runtime log"))
                .font(.headline)
            ScrollView {
                Text(model.logs.isEmpty ? model.text("暂无日志", "No logs yet") : model.logs)
                    .font(.system(size: 11, design: .monospaced))
                    .foregroundStyle(model.logs.isEmpty ? .secondary : .primary)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .topLeading)
                    .padding(10)
            }
            .background(Color(nsColor: .textBackgroundColor))
            .overlay(Rectangle().stroke(Color(nsColor: .separatorColor), lineWidth: 1))
        }
        .padding(20)
    }

    private var footer: some View {
        HStack {
            Button(action: model.saveConfiguration) {
                Label(model.text("保存", "Save"), systemImage: "square.and.arrow.down")
            }
            Spacer()
            if model.servicePhase == .running || model.servicePhase == .starting {
                if model.servicePhase == .running {
                    Button {
                        Task { await model.restart() }
                    } label: {
                        Label(model.text("重启服务", "Restart service"), systemImage: "arrow.clockwise")
                    }
                    .disabled(model.isBusy)
                }
                Button(action: model.stop) {
                    Label(model.text("停止服务", "Stop service"), systemImage: "stop.fill")
                }
            } else {
                Button {
                    Task { await model.start() }
                } label: {
                    Label(model.text("启动服务", "Start service"), systemImage: "play.fill")
                }
                .buttonStyle(.borderedProminent)
                .disabled(model.isBusy)
            }
        }
        .padding(16)
    }

    private func statusLabel(_ phase: RuntimePhase) -> some View {
        HStack(spacing: 6) {
            Circle()
                .fill(phase == .running ? Color.green : phase == .failed ? Color.red : Color.secondary)
                .frame(width: 8, height: 8)
            Text(model.display(phase.label))
                .font(.callout.weight(.medium))
        }
        .accessibilityLabel("\(model.text("服务状态", "Service status")): \(model.display(phase.label))")
    }

    private func textRow(
        _ label: String,
        text: Binding<String>,
        placeholder: String
    ) -> some View {
        LabeledContent(label) {
            TextField(placeholder, text: text)
                .textFieldStyle(.roundedBorder)
                .frame(width: 360)
        }
    }

    private func numberRow(_ label: String, value: Binding<Int>, placeholder: String) -> some View {
        LabeledContent(label) {
            TextField(placeholder, value: value, format: .number)
                .textFieldStyle(.roundedBorder)
                .frame(width: 120)
        }
    }

    private func secureRow(_ label: String, text: Binding<String>) -> some View {
        LabeledContent(label) {
            SecureField(model.text("至少 8 个字符，建议 32+", "At least 8 characters; 32+ recommended"), text: text)
                .textFieldStyle(.roundedBorder)
                .frame(width: 360)
        }
    }

    private func fileRow(
        _ label: String,
        text: Binding<String>,
        title: String,
        executable: Bool = false,
        placeholder: String? = nil
    ) -> some View {
        LabeledContent(label) {
            HStack(spacing: 8) {
                TextField(placeholder ?? model.text("选择文件", "Select a file"), text: text)
                    .textFieldStyle(.roundedBorder)
                    .frame(width: 320)
                Button {
                    model.chooseFile(title: title, executable: executable) { text.wrappedValue = $0 }
                } label: {
                    Image(systemName: "folder")
                }
                .help(title)
            }
        }
    }

    private func diagnosticRow(_ label: String, value: BilingualText, phase: RuntimePhase? = nil) -> some View {
        let successful = phase == .running
            || value.chinese == "已连接"
            || value.chinese == "运行中"
            || value.chinese == "可访问"
        return GridRow {
            Text(label).foregroundStyle(.secondary).frame(width: 100, alignment: .leading)
            HStack(spacing: 7) {
                Image(systemName: successful ? "checkmark.circle.fill" : "circle.dashed")
                    .foregroundStyle(successful ? Color.green : Color.secondary)
                Text(model.display(value))
            }
        }
    }
}
