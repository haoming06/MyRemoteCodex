# My Remote Codex 用户指南

本文包含安装启动、手机操作、中文输入、完整配置、安全边界和实机验证。项目概览见 [README](../README.md)，公网自托管见 [FRP 自托管部署](frp-self-hosting.md)。

## 环境要求

- macOS 和官方 Codex 桌面客户端。
- Node.js 22 或更高版本。
- 手机与 Mac 位于同一可信局域网；跨网络可以使用 Tailscale、WireGuard，或按安全边界配置 FRP。

## 安装与启动

首次安装：

```bash
npm install
npm run build:native:macos
npm run build
```

首次本地调试 H.264 时，如果服务所在环境不能自动调用 LaunchServices，请在 Finder 中手动打开一次：

```text
native/macos-capture/.build/My Remote Codex Capture.app
```

应用会在后台等待 My Remote Codex 连接。它只监听 `127.0.0.1:43891`，并使用权限为 `0600` 的随机本机令牌鉴权，不开放局域网端口，也不会采集其他应用或系统音频。

1. 正常退出正在运行的 Codex 客户端。
2. 用项目脚本重新启动 Codex，并让 CDP 只监听回环地址：

```bash
./scripts/launch-codex-macos.sh
```

3. 启动网页网关。局域网访问需要监听所有本机网卡：

```bash
REMOTE_CODEX_ALLOW_INSECURE_HTTP=true REMOTE_CODEX_HOST=0.0.0.0 npm start
```

终端会显示随机配对码、当前电脑的本地 URL 和局域网 URL。在手机浏览器打开局域网 URL，输入配对码即可连接。
明文局域网模式必须通过 `REMOTE_CODEX_ALLOW_INSECURE_HTTP=true` 显式确认；它只适合完全可信且隔离的网络。否则，非回环监听必须同时配置 TLS 证书和私钥，程序会拒绝启动。

本机开发时可使用：

```bash
npm run dev
```

## 手机操作

- 浏览模式：单指滑动转为 Codex 页面滚动；放大后单指滑动用于平移画面。
- 直接触控：单指按下、移动、抬起直接映射为远端鼠标事件，适合拖动和精确操作。
- 双指：围绕手指中心缩放，最大 4 倍。
- 底部输入栏：使用手机或当前电脑自己的输入法完成中文选词，再以一条原子操作聚焦 Codex、插入文字并触发 Enter。
- 任务执行中仍可使用底部输入栏发送补充指令；收到 Codex 渲染进程确认后输入栏才会清空。
- 多台设备同时连接时，从“仅查看”设备发送内容会自动接管控制权，原控制设备随即切换为仅查看。
- 顶栏清晰度：普通档使用固定的带宽友好上限；高清档按 Codex 窗口 DPR 请求原生像素，并受配置上限保护。
- 连接状态旁显示实际绘制帧率、接收码率和帧确认往返时间，可用于判断瓶颈是在画面解码还是公网链路。
- 顶栏按钮：切换触控模式、适合窗口、重置 1:1、全屏和断开设备。

## 中文键盘输入

- 电脑端点击 Codex 画面后，网页会启用一个原生键盘捕获器。中文、日文等组合输入会在本机输入法完成选词后再发送，不转发中间拼音。
- 退格、前向删除、方向键、Home/End、Enter、Tab、Escape、功能键、长按按键及常用组合快捷键会按 Chromium 原生键盘事件转发。
- 输入法切换发生在访问端设备上。例如手机使用手机输入法，另一台电脑使用那台电脑的输入法；无需也无法通过 CDP 切换 Mac 主机的系统输入法。
- 中文显示优先使用 `PingFang SC`、`Microsoft YaHei` 和 `Noto Sans CJK SC` 等系统字体回退。
- 手机端建议直接使用底部输入栏；它对 IME composition 和执行中补充消息做了专门处理。

## 配置

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `REMOTE_CODEX_HOST` | `127.0.0.1` | 网页服务监听地址；手机访问用 `0.0.0.0` |
| `REMOTE_CODEX_ALLOW_INSECURE_HTTP` | `false` | 是否显式允许非回环明文 HTTP；只用于完全可信且隔离的局域网 |
| `REMOTE_CODEX_PORT` | `4310` | 网页服务端口 |
| `REMOTE_CODEX_CDP_PORT` | `9341` | 本机 CDP 端口 |
| `REMOTE_CODEX_PAIRING_CODE` | 随机 8 位 | 可选固定配对码，必须恰好为 8 位字母或数字 2-9；校验不区分字母大小写 |
| `REMOTE_CODEX_SESSION_HOURS` | `12` | 会话有效小时数，范围 1-168 |
| `REMOTE_CODEX_JPEG_QUALITY` | `82` | 普通档 JPEG 质量，范围 30-100 |
| `REMOTE_CODEX_MAX_FRAME_WIDTH` | `1600` | 普通档最大宽度 |
| `REMOTE_CODEX_MAX_FRAME_HEIGHT` | `1200` | 普通档最大高度 |
| `REMOTE_CODEX_NORMAL_MAX_FPS` | `20` | 普通档最大发送帧率，范围 5-60 |
| `REMOTE_CODEX_HIGH_JPEG_QUALITY` | `92` | 高清档 JPEG 质量，范围 30-100 |
| `REMOTE_CODEX_HIGH_MAX_FRAME_WIDTH` | `4096` | 高清档最大宽度；实际宽度取 CSS 宽度乘 DPR 与此值中的较小值 |
| `REMOTE_CODEX_HIGH_MAX_FRAME_HEIGHT` | `4096` | 高清档最大高度；实际高度取 CSS 高度乘 DPR 与此值中的较小值 |
| `REMOTE_CODEX_HIGH_MAX_FPS` | `30` | 高清档最大发送帧率，范围 5-60 |
| `REMOTE_CODEX_BACKGROUND_CAPTURE_DELAY_MS` | `1500` | 连续多久没有 screencast 帧后检查页面是否隐藏 |
| `REMOTE_CODEX_BACKGROUND_CAPTURE_INTERVAL_MS` | `1000` | 隐藏状态下主动 JPEG 截图间隔 |
| `REMOTE_CODEX_VIDEO_TRANSPORT` | `auto` | `auto` 优先使用 H.264/WebRTC，`jpeg` 强制使用 JPEG |
| `REMOTE_CODEX_NATIVE_CAPTURE_BINARY` | `My Remote Codex Capture.app` 内的可执行文件 | macOS 原生采集辅助程序路径 |
| `REMOTE_CODEX_NATIVE_CAPTURE_BUNDLE_ID` | `com.openai.codex` | 只允许采集的应用 Bundle ID |
| `REMOTE_CODEX_VIDEO_NORMAL_FPS` | `30` | H.264 普通档帧率 |
| `REMOTE_CODEX_VIDEO_NORMAL_MAX_WIDTH` | `1600` | H.264 普通档最大像素宽度 |
| `REMOTE_CODEX_VIDEO_NORMAL_BITRATE` | `3000000` | H.264 普通档目标码率，单位 bit/s |
| `REMOTE_CODEX_VIDEO_HIGH_FPS` | `45` | H.264 高清档帧率 |
| `REMOTE_CODEX_VIDEO_HIGH_MAX_WIDTH` | `2560` | H.264 高清档最大像素宽度 |
| `REMOTE_CODEX_VIDEO_HIGH_BITRATE` | `7000000` | H.264 高清档目标码率，单位 bit/s |
| `REMOTE_CODEX_WEBRTC_ICE_SERVERS` | `[]` | ICE 服务器 JSON；公网使用 WebRTC 时配置 STUN/TURN |
| `REMOTE_CODEX_TLS_CERT` | 无 | HTTPS 证书路径，需与私钥同时配置 |
| `REMOTE_CODEX_TLS_KEY` | 无 | HTTPS 私钥路径 |
| `REMOTE_CODEX_PUBLIC_ORIGIN` | 无 | 外部 HTTPS 反向代理或隧道使用的公开 Origin；配置后服务必须只监听回环地址 |
| `REMOTE_CODEX_SECURE_COOKIE` | 有 TLS 时启用 | 是否强制 Secure Cookie |

FRP 模式需要额外配置公网 `frps`、HTTPS 鉴权网关以及下列环境变量。完整部署方式见 [FRP 自托管部署](frp-self-hosting.md)。

### 外部 HTTPS 接入

通过应用外部的 HTTPS 隧道或反向代理把本机 HTTP 服务转发为公网 HTTPS 时，不需要启用应用内置的“FRP 自托管隧道”。在 DMG 的“常规”页填写最终生成的“授权的外部 HTTPS 来源”，保存并重启服务，然后使用该公网地址访问。

该地址必须是完整的 HTTPS Origin，只能包含协议、域名和可选端口，不能包含路径、参数或凭据。应用会精确校验浏览器 `Origin`，自动使用 Secure Cookie，并继续只监听 `127.0.0.1`。公网地址发生变化时，需要同步更新此配置。

外部接入点会终止浏览器 TLS 并把请求转发到本机，因此只能在受信任的基础设施上启用；此模式不包含自托管 FRP 网关 token 提供的额外保护。

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `REMOTE_CODEX_FRP_ENABLED` | `false` | 是否由本进程启动并管理 `frpc` |
| `REMOTE_CODEX_FRP_BINARY` | `frpc` | `frpc v0.71.0` 命令或绝对路径 |
| `REMOTE_CODEX_FRP_SERVER_ADDR` | 无 | `frps` 主机名或 IP，不接受 URL |
| `REMOTE_CODEX_FRP_SERVER_PORT` | `7000` | `frpc` 连接 `frps` 的端口 |
| `REMOTE_CODEX_FRP_CLIENT_ID` | 无 | 设备唯一标识，只允许受限 ASCII 标识符 |
| `REMOTE_CODEX_FRP_USER` | 无 | FRP 代理命名空间；自托管时由管理员分配 |
| `REMOTE_CODEX_FRP_SUBDOMAIN` | 无 | FRP 子域标签，只允许小写 DNS label |
| `REMOTE_CODEX_FRP_TOKEN_FILE` | 无 | FRP token 文件，必须为当前用户所有且权限不高于 `0600` |
| `REMOTE_CODEX_FRP_GATEWAY_TOKEN_FILE` | 无 | 公网网关注入请求头所用的独立密钥文件，要求同上 |
| `REMOTE_CODEX_FRP_TRUSTED_CA` | 无 | 验证 `frps` 证书的 CA 文件 |
| `REMOTE_CODEX_FRP_SERVER_NAME` | 无 | `frps` 证书中的服务端名称 |
| `REMOTE_CODEX_FRP_CLIENT_CERT` | 无 | 可选 mTLS 客户端证书，需与私钥同时配置 |
| `REMOTE_CODEX_FRP_CLIENT_KEY` | 无 | 可选 mTLS 客户端私钥，必须为当前用户所有且权限不高于 `0600` |

## 安全边界

CDP 本身没有身份认证，并且拥有接近桌面应用渲染进程的控制能力。因此：

- 不要把 `9341` 端口做端口转发、反向代理或公网映射。
- 不要把网页网关或 FRP vhost 直接暴露在公网。FRP 模式必须由 HTTPS 网关覆盖并注入独立的网关密钥请求头。
- 非回环明文 HTTP 默认被拒绝；只有显式设置 `REMOTE_CODEX_ALLOW_INSECURE_HTTP=true` 才能用于完全可信且隔离的局域网。非可信网络必须配置 HTTPS、可信 VPN 或受保护的 FRP 网关。
- 服务端只接受预定义的指针、滚轮、按键、文字和少量命令。客户端不能提交任意 `Runtime.evaluate`；服务端仅使用固定表达式识别和聚焦 Codex 编辑器。
- 当前会话存储在内存中，服务重启后全部失效；登出或会话到期会立即断开该会话的控制连接，同一时间只有一个浏览器持有控制权。

## 故障排查

### 未弹出屏幕录制授权提示

少数情况下，macOS 没有弹出 `My Remote Codex Capture` 的屏幕录制授权提示，远程画面会回退到 JPEG。确认“系统设置”→“隐私与安全性”→“屏幕与系统音频录制”中没有可用的授权项后，可执行：

```bash
tccutil reset ScreenCapture com.myremotecodex.capture
killall remote-codex-capture 2>/dev/null
```

第一条命令会清除采集器现有的屏幕录制授权记录，第二条命令会停止采集器进程。随后刷新远程页面或重新启动服务，让系统再次启动采集器并弹出授权提示；授权后再刷新一次远程页面。

## 已知限制

- macOS 原生通道通过 ScreenCaptureKit 只采集 Codex 窗口，再由 VideoToolbox 硬件编码 H.264；它不是整个操作系统的远程桌面。
- 原生辅助程序不存在、屏幕录制权限未授予、浏览器不支持 H.264 或 WebRTC 建连失败时，会自动回退到 JPEG 二进制 WebSocket。
- 首次使用 H.264 时，服务会通过 LaunchServices 启动 `My Remote Codex Capture.app`。该应用持有屏幕录制权限，并通过带随机本机令牌鉴权的 `127.0.0.1` TCP 连接向服务传输 H.264；本项目不采集音频。
- 屏幕录制权限应授予 `native/macos-capture/.build/My Remote Codex Capture.app`。不要只授权 Codex、Terminal 或包内裸二进制。授权后刷新远程页面即可创建新的采集连接。
- 本地源码构建使用 ad-hoc 签名，重新构建原生应用后 macOS 可能要求重新授权。面向用户发布时必须使用稳定的 Apple Development 或 Developer ID 证书签名，才能跨版本保留 TCC 身份。
- FRP 只转发 HTTPS/WSS 和 WebRTC 信令，不转发 WebRTC 媒体。跨公网需要额外配置 TURN，或明确部署可达的 WebRTC UDP 网络；否则继续使用 JPEG 回退。
- 画面使用二进制 WebSocket 传输，每个浏览器最多保留两帧在途和一帧最新待发画面；拥塞时会主动丢弃过期帧，优先保持操作反馈及时。
- ScreenCaptureKit 使用离屏窗口枚举，可改善最小化后的采集；macOS 已锁屏或进入睡眠后仍可能因系统安全与图形合成策略停止新画面，不能保证锁屏远控。
- 移动端无法获得桌面应用级别的无障碍语义，复杂拖拽仍建议使用电脑。
- Codex 内部页面或 Electron 行为变化后，CDP 目标探测可能需要更新。
- 当前验证不会自动退出或重启正在使用的 Codex 客户端，真实连接需按“安装与启动”步骤手动进行。

## 实机输入验证

保持 Codex 输入框为空且不要同时操作键盘，然后运行：

```bash
npm run verify:live-input
```

脚本会在真实 Codex 输入框插入 `ab中文`，依次验证退格、左移、前向删除、Home 和 End，随后自动清空测试内容，全程不会发送消息。
