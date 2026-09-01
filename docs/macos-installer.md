# macOS 安装版

安装版把配置应用、Node.js 运行时、网页服务、原生 H.264 采集器和 `frpc v0.71.0` 放进同一个 `My Remote Codex.app`，用户电脑不需要另外安装 Node.js。

## 构建安装包

在 macOS 上执行以下命令，一次生成 Apple 芯片和 Intel 两套安装包：

```bash
npm install
npm run build:macos:installers
```

构建会分别输出：

```text
dist/installers/My-Remote-Codex-<版本>-arm64.dmg
dist/installers/My-Remote-Codex-<版本>-x86_64.dmg
dist/installers/My-Remote-Codex-<版本>-arm64.pkg
dist/installers/My-Remote-Codex-<版本>-x86_64.pkg
```

`arm64` 用于 Apple 芯片，`x86_64` 用于 Intel。构建脚本会按目标架构编译 Swift 主程序和采集器，并下载经过 SHA-256 校验的对应 Node.js 与 `frpc`。首次构建需要访问 Node.js 和 FRP 的官方下载地址；后续构建会复用本地缓存。

只需要单一架构时，可以执行：

```bash
TARGET_ARCH=arm64 npm run build:macos:installer
TARGET_ARCH=x86_64 npm run build:macos:installer
```

运行对应的 PKG，或打开 DMG 后把应用拖到“应用程序”即可。

首次启动后可在配置窗口完成：

- 设置或重新生成配对码；
- 选择仅本机访问或可信局域网访问；
- 为外部 HTTPS 隧道或反向代理填写最终生成的公开地址；
- 默认在服务运行时防止 Mac 自动休眠，避免 CDP 和屏幕采集连接中断；
- 启动 Codex CDP 和网页服务；
- 选择通用 FRP TOML，或配置服务器、设备、TLS 和 token 的自托管模式；
- 测试本机服务、Codex CDP、FRP 隧道及公网健康地址；
- 查看服务端和 `frpc` 运行日志。

配置保存在 `~/Library/Application Support/My Remote Codex`。配置、FRP token 和网关 token 的文件权限为 `0600`；FRP 启用后网页服务仍只监听 `127.0.0.1`。

使用 NiceFRP 等服务商配置时，在“FRP”页选择“通用 TOML”，选择权限不高于 `0600` 的 TOML 和最终生成的 HTTPS 公开地址。应用会管理该 `frpc` 进程并显示状态和日志，但不会复制或重写 TOML 中的 token。使用其他独立 HTTPS 反向代理时，仍可在“常规”页只填写“授权的外部 HTTPS 来源”。

“服务运行时防止 Mac 自动休眠”位于“常规”页并默认开启。该设置只阻止系统因空闲而自动休眠；停止服务后会立即释放，也不会拦截用户主动睡眠、合盖、关机或电量保护行为。

## 正式签名与公证

本地构建默认使用 ad-hoc 签名，只适合开发测试。公开分发应使用 Developer ID 并完成 Apple 公证：

```bash
CODESIGN_IDENTITY="Developer ID Application: Example (TEAMID)" \
INSTALLER_IDENTITY="Developer ID Installer: Example (TEAMID)" \
NOTARY_KEYCHAIN_PROFILE="my-remote-codex-notary" \
npm run build:macos:installers
```

发布版本必须始终使用相同的应用与采集器 Bundle ID、Developer ID 和签名链，否则 macOS 可能把屏幕录制权限识别为新的应用。

构建脚本会使用 Developer ID Application 对应用和 DMG 签名，并将 DMG 提交 Apple 公证后装订票据。只有需要分发 PKG 时才需要配置 `INSTALLER_IDENTITY`；未配置时仍会生成未签名的 PKG，但不会提交 PKG 公证。
